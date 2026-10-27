# SPEC técnico — Neurosymbolic Requirements Auditor

Complementa el PRD v0.1. Si algo no está aquí ni en el PRD, no se construye.
Precedencia ante conflicto: `tests/gold/` > este SPEC > PRD.

Incluye el delta v2 del 27-oct-2026: el dispositivo es un monitor continuo de glucosa (CGM), el tiempo va en segundos con un tick de `signals.json`, las obligaciones que pasan el horizonte se reportan como `unverified` y hay un agente regulatorio (§10). El corpus de la bomba de infusión queda en el historial de git.

## 1. Stack (decidido con Simón el 27-oct-2026)

| Capa | Elección |
|---|---|
| Lenguaje | TypeScript 6.0 strict, Node 22 |
| Monorepo | pnpm workspaces + Turborepo |
| Schemas y validación | Zod 4 |
| Solver | `z3-solver` 5.3.2 (WASM oficial), solo en servidor |
| LLM | SDK `openai` 7, structured outputs con `zodResponseFormat`; OpenAI directo, modelo en una constante |
| API | Express 5 |
| UI | React 19 + Vite 8 + Tailwind 4 |
| Persistencia | JSON versionado en `corpus/`; sin base de datos |
| Tests | Vitest 5 |
| Calidad | `tsc --noEmit`, ESLint 10 + typescript-eslint 8, knip |
| Deploy | Render free: un servicio Node; Express sirve la API y `apps/web/dist` |

TypeScript va fijado en 6.0 porque typescript-eslint 8 requiere `<6.1`.

## 2. Layout (cerrado)

```
packages/core/src/
  schema.ts      # Zod: Signal, Requirement, Axiom, Scenario, Finding, Status
  corpus.ts      # lee y valida corpus/ con Zod (frontera de errores, SPEC §6); aplica mutaciones (§7)
  encode.ts      # Requirement/Axiom/Scenario → fórmulas Z3 sobre la traza BMC
  checks.ts      # 5 checks + minimización de core + unverified. Único lugar con Solver
  regression.ts  # diff de findings entre dos snapshots
  index.ts       # exports públicos
apps/api/src/
  server.ts      # Express: rutas + sirve web/dist
  llm.ts         # texto → Requirement.formal vía OpenAI. Único import de `openai`
  evals.ts       # CLI `pnpm eval`: variantes A/B/C → runs/<run_id>.json; `--rescore` por slices
  agent.ts       # agente regulatorio (§10, etapa 06)
  tools.ts       # herramientas deterministas del agente (§10, etapa 06)
apps/web/src/
  App.tsx + componentes de las 4 vistas del storyboard
corpus/          # signals.json, requirements/, axioms.json, scenarios/, interpretations/, snapshots/, invalid/, regulations/
tests/gold/      # cases.json, mutations.json, gen-mutations.mjs, obligations.json (Simón aprueba; solo lectura para el agente)
```

`z3-solver` solo se importa en `encode.ts` y `checks.ts`; `openai` solo en `llm.ts` (lo hace cumplir ESLint `no-restricted-imports`).

## 3. Modelo formal: trazas acotadas (BMC)

`corpus/signals.json` fija el vocabulario: `tick_s`, `horizon_ticks`, `modes`, `signals`. Todo lo demás se valida contra él. **Ningún número del modelo va escrito a mano en el código**: el horizonte, el tick y los modos salen de ahí.

Vocabulario actual: `tick_s = 60` (1 tick = 1 minuto), `horizon_ticks = 45` (minutos 0..44), modos `WARMUP`, `ACTIVE`, `EXPIRED`, señales `urgent_low`, `urgent_low_alert`, `glucose_shown`, `data_gap`, `signal_loss_alert`, `reading_sent`.

- **Unidades:** todo dato temporal del corpus va en segundos: `s`, `window_s`, `min_s`, `max_s`, `from_s`, `to_s`. El encoder divide por `tick_s`. Un valor que no es múltiplo de `tick_s` es `PARSE_ERROR` (G11: REQ-902 con 90 s).
- **Traza:** ticks `k = 0..H−1`, con `H = horizon_ticks`.
- **Estado por tick:** un `Bool` por señal y `mode_k` como enum de Z3 con los modos del vocabulario.
- **Entrada a un modo:** `entered(M, e)` ⇔ `mode_e = M` y (`e = 0` o `mode_{e-1} ≠ M`).
- **Todos los intervalos son semiabiertos `[from, to)`**: ventanas de scope y hechos de escenario.

Semántica exacta de un requisito, para cada tick `k` (las duraciones ya divididas por `tick_s`):
- `trigger(k)` = `in_scope(k) ∧ condition(k)` (con `condition null` → true).
- `in_scope(k)`: `ANY` → true. Modo `M` sin ventana → `mode_k = M`. Con ventana `[from, to)` → existe una entrada `e ≤ k` con `entered(M, e)`, `mode_j = M` para todo `j ∈ [e, k]`, y `from ≤ k − e < to`.
- `always`: `trigger(k) → response(k)`.
- `within s`: con `d = s / tick_s`, `last = k + d` (inclusive) o `k + d − 1` (exclusive). Si `last > H − 1`, el tick `k` no restringe nada (truncamiento en el horizonte), pero no se descarta en silencio: entra al chequeo `unverified` (§4). Si no, `trigger(k) → ∃ j ∈ [k, last]: response(j)`.

Sin el truncamiento aparecen UNSAT espurios al final de la traza (lo prueba el caso gold G04).

### DSL: plantilla plana estilo FRET, no AST recursivo

El LLM llena campos tipados; no hay expresiones anidadas. `encode.ts` traduce cada combinación a fórmulas sobre la traza.

```ts
Requirement = {
  id, version, text,
  source: { kind: "anchored" | "synthetic", ref: string | null, note: string },
  status: "pending" | "approved", approved_by: string | null,
  formal: null | {                                             // null solo si status = "pending"
    scope:     { mode: "ANY" | Mode,                           // Mode: uno de signals.json
                 window_s: { from: int, to: int } | null },   // segundos, relativo a la entrada al modo
    condition: { signal: SignalName, value: boolean } | null, // disparador
    timing:    { kind: "within", s: int, bound: "inclusive" | "exclusive" }
             | { kind: "always" },
    response:  { signal: SignalName, value: boolean },
  }
}
```

Lecturas canónicas:
- REQ-101: `scope ANY`, `condition urgent_low=true`, `timing within 300 inclusive`, `response urgent_low_alert=true`.
- REQ-102: `scope WARMUP, window 0–1800`, `condition null`, `timing always`, `response urgent_low_alert=false`.

**Axiomas (`AX-*`), en `corpus/axioms.json`:**
- `{ kind: "mode_duration", mode, min_s, max_s }`: con `min = min_s / tick_s` y `max = max_s / tick_s`, tras cada entrada `e` el modo se mantiene en `[e, min(e + min, H))` y `mode_{e+max} ≠ M` si `e + max ≤ H − 1`. Una corrida cortada por el horizonte es válida.
- `{ kind: "signal_impossible_in_mode", signal, mode }`: `mode_k = M → ¬signal_k` para todo `k`.

**Escenarios (`SCN-*`):** `facts` es una lista de `{ mode, from_s, to_s }` o `{ signal, value, from_s, to_s }`. Lo que un escenario no fija queda libre.

**Interpretaciones (`INT-*`):** `{ id, requirement_id, question, context_scenario, readings: { A: formal, B: formal } }`. El `context_scenario` mantiene legible el witness (G07: urgent low en el minuto 2 → alerta en el minuto 7).

**Snapshots:** `corpus/snapshots/<nombre>/requirements/*.json` reemplazan por `id` a los de `corpus/requirements/`. `base` es el corpus sin reemplazos.

Señal o modo no declarados, o segundos no enteros o no múltiplos de `tick_s` → `PARSE_ERROR` (lo rechaza Zod). `corpus/invalid/` existe solo para probarlo.

## 4. Chequeos

Cada requisito, axioma y hecho se asserta como `Implies(p_id, fórmula)` con un literal `p_id`, y se resuelve con `solver.check(...literales)` + `solver.unsatCore()`.

| Check | Fórmula | Salida |
|---|---|---|
| `consistency` | AX ∧ REQ | UNSAT → core |
| `scenario_conflict` | AX ∧ REQ ∧ SCN | UNSAT → core · SAT → traza witness + `unverified` |
| `vacuity` (por req con `condition`) | AX ∧ REQ∖{r} ∧ `TRIGGER:r` = ∃k: trigger_r(k) | UNSAT → disparador inalcanzable |
| `equivalence` (A vs B) | AX ∧ SCN(context) ∧ ¬(A ↔ B) | SAT → traza witness de frontera |
| `regression` | diff de findings entre snapshots | introducido / resuelto / persistente |

`REQ` = solo requisitos `approved`. Cada requisito `pending` genera además su propio finding `NEEDS_REVIEW`. Los ids del core son ids de corpus o `TRIGGER:<req>`.

- **Obligaciones no verificadas:** `scenario_conflict` con resultado SAT devuelve además `unverified: {requirement, tick}[]`. Un par entra si (a) el timing del requisito es `within`, (b) su `last` en ese tick pasa `H − 1`, y (c) el disparador se cumple en **todo** modelo de AX ∧ REQ ∧ SCN. Para comprobar (c), un check con la assumption ¬trigger(k) debe dar UNSAT. El witness no decide: solo descarta pares cuyo disparador es falso en él. Todo par reportado sale de un check UNSAT. Se reutiliza el solver del check SAT (incremental). La lista va ordenada por requirement y luego por tick; si el resultado es UNSAT, va vacía. Si alguno de esos checks da `unknown`, el finding entero es `UNKNOWN`.
- **Core mínimo:** el core de Z3 no es mínimo por garantía. Se minimiza por deletion: se quita un literal, se re-chequea y, si sigue UNSAT, se descarta.
- **Identidad de un finding:** `(check, scenario_id | null, ids del core ordenados)`. La regresión compara por esta clave.
- **Solver:** `random_seed = 0`, `timeout = 2000` ms; si vence → `UNKNOWN`. Un solo `Context` inicializado al arrancar el servidor.
- **Witness:** tabla tick × señal/modo; la UI la dibuja como timeline.
- **Auditoría:** auditoría = consistency + scenario_conflict por cada escenario + vacuity + equivalence por cada interpretación, sobre el corpus base, en un proceso que ya hizo 1 auditoría completa de calentamiento (como corre el servidor). La primera auditoría del proceso se reporta aparte como `cold_first_audit_ms`.

**Status:** `SAT | UNSAT | UNKNOWN | PARSE_ERROR | NEEDS_REVIEW`. No existe ningún campo tipo `compliant`. Un requisito `pending` nunca se excluye en silencio.

## 5. LLM (`apps/api/src/llm.ts`)

- `client.chat.completions.parse` con `response_format: zodResponseFormat(z.strictObject({ formal: FormalSchema.nullable() }), "requirement")`. La salida se re-valida con el mismo schema Zod.
- `extract` responde `{ formal: Formal | null }`, no `Formal` a secas. Structured outputs exige un objeto en la raíz del schema, y el `null` es la única forma de que el modelo diga que el texto no se puede expresar con el vocabulario de `signals.json` (REQ-108) sin inventar una lectura. Un `formal: null`, igual que un error de la llamada, deja el requisito `pending` → `NEEDS_REVIEW`.
- Modelo y prompt son constantes versionadas; cada `run_id` los registra.
- El LLM solo propone `formal`. Nunca decide SAT/UNSAT, nunca marca `approved`, nunca produce código.
- Variante B del eval (LLM-only judge): devuelve `{ conflict: boolean, involved_ids: string[] }` con su propio schema Zod.

## 6. Errores: fail closed, sin fallbacks

- `try/catch` solo en dos fronteras: la carga de archivos de `corpus/` y la llamada al LLM. Ahí el error se convierte en `PARSE_ERROR` o `NEEDS_REVIEW` conservando el mensaje original. En el resto del código, el error se propaga.
- Si la extracción LLM falla, el requisito queda `pending`. La UI muestra fixtures revisadas solo si el usuario elige el modo `fixtures`, nunca como respaldo automático.
- No hay retries, caché, feature flags, configuración dinámica ni clases abstractas. Log: un JSON por ejecución en `runs/<run_id>.json` (`stage`, `latency_ms`, `tokens`, `status`).

## 7. Datos

**Estrategia: sintéticos anclados.** Cada requisito es `anchored` (paráfrasis de un requisito público real, citado en `source.ref`) o `synthetic` (escrito para el demo, con la razón en `source.note`). Los conflictos se inyectan a propósito y quedan declarados. No se copia texto literal de las fuentes en los requisitos.

**Fuentes de anclaje:**
- `corpus/regulations/21-CFR-862.1355.txt`: texto oficial del eCFR (versión 2026-10-01, dominio público). Es la entrada del agente (§10).
- 21 CFR 862.1355(b)(1)(vii), (b)(2), (b)(5) y (b)(7)(iv).
- Resumen de decisión 510(k) K213996 de la FDA (FreeStyle Libre 3): la alerta Urgent Low es obligatoria y no se puede apagar.

Los umbrales (5 min, 10 min, 1 min) son nuestros; la regulación no los fija, y así lo dice cada `source.note`.

**Corpus base** (`corpus/`): 8 requisitos, 2 axiomas, 5 escenarios, 2 interpretaciones, 2 snapshots, 2 inválidos y 1 regulación.

| Id | Tipo | Rol en el demo |
|---|---|---|
| REQ-101 | anchored K213996 | Alerta Urgent Low ≤ 5 min en cualquier modo; lado A del conflicto central |
| REQ-102 | synthetic | Sin alertas de glucosa en los primeros 30 min de calentamiento; conflicto inyectado |
| REQ-103 | synthetic | Sin valores de glucosa durante el calentamiento |
| REQ-104 | anchored (b)(2) | En `ACTIVE`, una lectura al menos cada 5 min; sus colas pasan el horizonte (`unverified`) |
| REQ-105 | anchored (b)(1)(vii) | Sin datos 10 min → alerta Signal Loss ≤ 1 min |
| REQ-106 | anchored (b)(5) | Sensor vencido → no mostrar glucosa |
| REQ-107 | synthetic | Objetivo de vacuidad: urgent low con sensor vencido (AX-102 lo hace inalcanzable) |
| REQ-108 | anchored (b)(7)(iv) | Obligación de etiquetado, sin formalizar a propósito → `NEEDS_REVIEW` |

Axiomas: AX-101 (el calentamiento dura exactamente 30 min) y AX-102 (un sensor vencido no mide glucosa).

**Conflicto central (G01):** REQ-101 choca con REQ-102 si hay glucosa urgentemente baja durante el calentamiento. Es realista: los CGM reales no dan lecturas en el calentamiento y lo resuelven con etiquetado. El snapshot `v2-scope-active` muestra esa corrección (REQ-101 limitado a `ACTIVE`); `v3-text-only` cambia solo el texto de REQ-102.

**Gold** (`tests/gold/cases.json`): 11 casos (G01–G11) con positivos y negativos. Incluye la frontera exacta (G03: la alerta puede sonar en el minuto 30), el horizonte (G04: SAT con REQ-101 `unverified` en el tick 42), el `NEEDS_REVIEW` (G05) y el `PARSE_ERROR` (G11). G01–G04 traen `expected_unverified`.

**Mutaciones** (`tests/gold/mutations.json`, generado por `gen-mutations.mjs`): 84 variantes de la familia REQ-101 × REQ-102 × escenario (58 UNSAT, 26 SAT). La etiqueta sale de una fórmula cerrada, no de Z3, para que el eval no califique al solver con el solver. Cada caso es autodescrito:
- `overrides`: campos de `formal` que se reemplazan, por id de requisito;
- `scenario`: el escenario completo, con sus `facts`;
- `expected_status`, `expected_core` y `expected_unverified`.

El test aplica los overrides sobre el corpus base completo (validados con los mismos schemas que `corpus/`), corre `scenario_conflict` y compara. No conoce nombres de requisitos ni de modos.

**Obligaciones** (`tests/gold/obligations.json`): los 27 párrafos hoja de 21 CFR 862.1355 con categoría, mapeo y veredicto esperado; los usa el agente (§10).

**Verificación previa:** un oráculo BMC independiente en Python (no incluido en el repo) reproduce los 11 casos y las 84 etiquetas.

**Aprobación:** los requisitos llegan con `status: "pending"`. Simón los revisa con `REVIEW.md` y aprueba los que acepta. El gold asume aprobados REQ-101…107 y los requisitos de los snapshots, con REQ-108 siempre pendiente.

## 8. Harness

- **Guías:** `CLAUDE.md` (solo lo no obvio), este SPEC, tests gold.
- **Sensores computacionales:**
  - Stop hook `scripts/gate.sh`: typecheck, lint, test, knip. Si falla, devuelve exit 2 y el turno no termina.
  - La tarea `test` de turbo declara `corpus/**` y `tests/gold/**` como inputs: un gate que pasa desde la caché no es un sensor.
  - ESLint: `complexity ≤ 8`; `no-restricted-syntax` contra `TryStatement` salvo en las dos fronteras; `no-restricted-imports` para z3 y openai; `no-explicit-any`; `ban-ts-comment`.
  - knip: archivos, exports y dependencias sin uso hacen fallar el gate.
  - `permissions.deny` sobre `tests/gold/**` y `corpus/**`.
- **Sensor inferencial:** subagente `scope-reviewer` al cerrar cada etapa; reporta solo gaps de correctitud y alcance.

## 9. Etapas en Claude Code

Una sesión por etapa; `/clear` entre etapas. Plan mode en las etapas 02 y 03.

| Etapa | Salida | Hecho cuando |
|---|---|---|
| 00 (Simón) | Revisar `corpus/` y `tests/gold/` con `REVIEW.md` | Requisitos aprobados; labels revisados a mano |
| 01 | Scaffold, `schema.ts`, `corpus.ts` | Gate verde; todo `corpus/` carga; G11 da `PARSE_ERROR` |
| 02 | `encode.ts`, `checks.ts`, `regression.ts` | Pasan todos los gold, positivos y negativos |
| 03 | `llm.ts`, `evals.ts` | A/B/C corren sobre gold + mutaciones y escriben métricas en `runs/` |
| 05 | Dominio CGM + unidades + `unverified` + mutaciones autodescritas + evals A/B/C con plantillas CGM | Gate verde con G01–G11 y 84 mutaciones; `pnpm eval` v3 y rescore por slices; latencia p95 < 2 s |
| 06 | `agent.ts`, `tools.ts`, `pnpm eval:agent` | Gate verde; una corrida real con métricas contra `obligations.json` |
| 07 | `server.ts`, `apps/web` | Storyboard de punta a punta en local |
| 08 | Deploy en Render + video | El link público reproduce el storyboard |

Servidor + UI (antes etapa 04) pasó a la 07, y el deploy (antes 05) a la 08.

Prompt por etapa: *"Implementa la etapa NN de SPEC.md. Corre `scripts/gate.sh` y muestra su salida. Al terminar, usa el subagente scope-reviewer sobre el diff."*

## 10. Agente regulatorio (`apps/api/src/agent.ts`, etapa 06)

**Objetivo:** dado un texto regulatorio, producir un *impact assessment* sobre los requisitos del producto. Cada obligación debe quedar clasificada, citada, mapeada a requisitos y con un veredicto basado en evidencia.

**Bucle:** OpenAI tool calling con el SDK `openai`, un máximo de 12 turnos y la temperatura mínima que el modelo permita. El LLM decide clasificación y mapeo. **Los veredictos los calcula el código, nunca el LLM.**

**Herramientas** (deterministas, en `apps/api/src/tools.ts`):
- `get_regulation()` devuelve los párrafos hoja con `{ id, context }`. El parser es determinista y no usa LLM; `context` es el texto de los ancestros más el del propio párrafo.
- `search_requirements(query)` devuelve `{ id, text, status }` de todos los requisitos cuyo texto contiene algún término de la búsqueda. No expone `source` ni `formal`: el mapeo tiene que ser semántico, no copiar trazas.
- `get_requirement(id)` devuelve `{ id, text, status, formal }`.
- `run_audit(requirement_ids)` corre la auditoría de §4 (consistency, scenario_conflict por escenario, vacuity, equivalence) y devuelve los findings que tocan esos ids: core, witness resumido y `unverified`.

**Salida del LLM** (schema Zod, structured output), un item por párrafo hoja:

```
{ paragraph, category: "behavior" | "evidence" | "labeling",
  quote: string,                 // debe ser substring exacto del context del párrafo
  implemented_by: string[],      // ids existentes
  rationale: string }            // máximo 2 frases
```

**Validación en código, fail-closed:**
- Si `quote` no es substring exacto del contexto del párrafo, el item queda `NEEDS_REVIEW` con motivo `invalid_quote`.
- Si un id de `implemented_by` no existe, el item queda `NEEDS_REVIEW` con motivo `unknown_requirement`.
- Si falta un párrafo hoja o hay uno de más, el item queda `NEEDS_REVIEW`.

**Veredicto por obligación** (calculado en código a partir de `run_audit`; lo define `tests/gold/obligations.json`): `CONFLICT`, `DEAD`, `NOT_FORMALIZED`, `NO_REQUIREMENT`, `CONSISTENT_BOUNDED`, `OUT_OF_SCOPE`.

**Salida final:** `runs/agent-<run_id>.json` con el reporte, la traza de llamadas a herramientas, los tokens y la latencia. Además, una auditoría completa del corpus que muestra el conflicto G01, aunque REQ-101 no esté mapeado a ningún párrafo: el reporte lo lista bajo "conflictos de diseño".

**Evals del agente** (`pnpm eval:agent`, 3 corridas):
- exactitud de categoría;
- precision y recall del mapeo `implemented_by` por par (párrafo, req);
- recall de gaps: obligaciones `NO_REQUIREMENT` detectadas;
- tasa de citas válidas;
- ids inventados (debe ser 0);
- exactitud del veredicto;
- acuerdo entre corridas, latencia y tokens.

Ningún test del gate llama a OpenAI. Los tests del gate cubren el parser, la validación de citas e ids, la derivación de veredictos con mapeos fijos y la función de métricas.
