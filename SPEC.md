# SPEC técnico — Neurosymbolic Requirements Auditor

Complementa el PRD v0.1. Si algo no está aquí ni en el PRD, no se construye.
Precedencia ante conflicto: `tests/gold/` > este SPEC > PRD.

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
  corpus.ts      # lee y valida corpus/ con Zod (frontera de errores, SPEC §6)
  encode.ts      # Requirement/Axiom/Scenario → fórmulas Z3 sobre la traza BMC
  checks.ts      # 5 checks + minimización de core. Único lugar con Solver
  regression.ts  # diff de findings entre dos snapshots
  index.ts       # exports públicos
apps/api/src/
  server.ts      # Express: rutas + sirve web/dist
  llm.ts         # texto → Requirement.formal vía OpenAI. Único import de `openai`
  evals.ts       # CLI `pnpm eval`: variantes A/B/C → runs/<run_id>.json
apps/web/src/
  App.tsx + componentes de las 4 vistas del storyboard
corpus/          # signals.json, requirements/, axioms.json, scenarios/, interpretations/, snapshots/, invalid/
tests/gold/      # cases.json, mutations.json, gen-mutations.mjs (Simón aprueba; solo lectura para el agente)
```

`z3-solver` solo se importa en `encode.ts` y `checks.ts`; `openai` solo en `llm.ts` (lo hace cumplir ESLint `no-restricted-imports`).

## 3. Modelo formal: trazas acotadas (BMC)

`corpus/signals.json` fija el vocabulario: `tick_s`, `horizon_ticks`, `modes`, `signals`. Todo lo demás se valida contra él.

- **Traza:** ticks `k = 0..19` (1 s por tick, horizonte 20 s).
- **Estado por tick:** un `Bool` por señal (`occlusion`, `alarm`, `bolus_delivered`, `reservoir_empty`, `fault`, `pumping`) y `mode_k` como enum de Z3 (`NORMAL`, `CALIBRATION`).
- **Entrada a un modo:** `entered(M, e)` ⇔ `mode_e = M` y (`e = 0` o `mode_{e-1} ≠ M`).
- **Todos los intervalos son semiabiertos `[from, to)`**: ventanas de scope y hechos de escenario.

Semántica exacta de un requisito, para cada tick `k`:
- `trigger(k)` = `in_scope(k) ∧ condition(k)` (con `condition null` → true).
- `in_scope(k)`: `ANY` → true. Modo `M` sin ventana → `mode_k = M`. Con ventana `[from, to)` → existe una entrada `e ≤ k` con `entered(M, e)`, `mode_j = M` para todo `j ∈ [e, k]`, y `from ≤ k − e < to`.
- `always`: `trigger(k) → response(k)`.
- `within s`: `last = k + s` (inclusive) o `k + s − 1` (exclusive). Si `last > 19`, el tick `k` no restringe nada (truncamiento en el horizonte). Si no, `trigger(k) → ∃ j ∈ [k, last]: response(j)`.

Sin el truncamiento aparecen UNSAT espurios al final de la traza (lo prueba el caso gold G04).

### DSL: plantilla plana estilo FRET, no AST recursivo

El LLM llena campos tipados; no hay expresiones anidadas. `encode.ts` traduce cada combinación a fórmulas sobre la traza.

```ts
Requirement = {
  id, version, text,
  source: { kind: "anchored" | "synthetic", ref: string | null, note: string },
  status: "pending" | "approved", approved_by: string | null,
  formal: null | {                                             // null solo si status = "pending"
    scope:     { mode: "ANY" | "NORMAL" | "CALIBRATION",
                 window_s: { from: int, to: int } | null },   // relativo a la entrada al modo
    condition: { signal: SignalName, value: boolean } | null, // disparador
    timing:    { kind: "within", s: int, bound: "inclusive" | "exclusive" }
             | { kind: "always" },
    response:  { signal: SignalName, value: boolean },
  }
}
```

Lecturas canónicas:
- REQ-001: `scope ANY`, `condition occlusion=true`, `timing within 5 inclusive`, `response alarm=true`.
- REQ-002: `scope CALIBRATION, window 0–10`, `condition null`, `timing always`, `response alarm=false`.

**Axiomas (`AX-*`), en `corpus/axioms.json`:**
- `{ kind: "mode_duration", mode, min_s, max_s }`: tras cada entrada `e`, el modo se mantiene en `[e, min(e + min_s, 20))` y `mode_{e+max_s} ≠ M` si `e + max_s ≤ 19`. Una corrida cortada por el horizonte es válida.
- `{ kind: "signal_impossible_in_mode", signal, mode }`: `mode_k = M → ¬signal_k` para todo `k`.

**Escenarios (`SCN-*`):** `facts` es una lista de `{ mode, from_s, to_s }` o `{ signal, value, from_s, to_s }`. Lo que un escenario no fija queda libre.

**Interpretaciones (`INT-*`):** `{ id, requirement_id, question, context_scenario, readings: { A: formal, B: formal } }`. El `context_scenario` mantiene legible el witness (G07: una oclusión en t=2 s → alarma en t=7 s).

**Snapshots:** `corpus/snapshots/<nombre>/requirements/*.json` reemplazan por `id` a los de `corpus/requirements/`. `base` es el corpus sin reemplazos.

Señal o modo no declarados, o segundos no enteros → `PARSE_ERROR` (lo rechaza Zod). `corpus/invalid/` existe solo para probarlo.

## 4. Chequeos

Cada requisito, axioma y hecho se asserta como `Implies(p_id, fórmula)` con un literal `p_id`, y se resuelve con `solver.check(...literales)` + `solver.unsatCore()`.

| Check | Fórmula | Salida |
|---|---|---|
| `consistency` | AX ∧ REQ | UNSAT → core |
| `scenario_conflict` | AX ∧ REQ ∧ SCN | UNSAT → core · SAT → traza witness |
| `vacuity` (por req con `condition`) | AX ∧ REQ∖{r} ∧ `TRIGGER:r` = ∃k: trigger_r(k) | UNSAT → disparador inalcanzable |
| `equivalence` (A vs B) | AX ∧ SCN(context) ∧ ¬(A ↔ B) | SAT → traza witness de frontera |

`REQ` = solo requisitos `approved`. Cada requisito `pending` genera además su propio finding `NEEDS_REVIEW`. Los ids del core son ids de corpus o `TRIGGER:<req>`.
| `regression` | diff de findings entre snapshots | introducido / resuelto / persistente |

- **Core mínimo:** el core de Z3 no es mínimo por garantía. Se minimiza por deletion: se quita un literal, se re-chequea y, si sigue UNSAT, se descarta.
- **Identidad de un finding:** `(check, scenario_id | null, ids del core ordenados)`. La regresión compara por esta clave.
- **Solver:** `random_seed = 0`, `timeout = 2000` ms; si vence → `UNKNOWN`. Un solo `Context` inicializado al arrancar el servidor.
- **Witness:** tabla tick × señal/modo; la UI la dibuja como timeline.
- **Auditoría:** auditoría = consistency + scenario_conflict por cada escenario + vacuity + equivalence por cada interpretación, sobre el corpus base, en un proceso que ya hizo un solve de calentamiento.

**Status:** `SAT | UNSAT | UNKNOWN | PARSE_ERROR | NEEDS_REVIEW`. No existe ningún campo tipo `compliant`. Un requisito `pending` nunca se excluye en silencio.

## 5. LLM (`apps/api/src/llm.ts`)

- `client.chat.completions.parse` con `response_format: zodResponseFormat(FormalSchema, "requirement")`. La salida se re-valida con el mismo schema Zod.
- Modelo y prompt son constantes versionadas; cada `run_id` los registra.
- El LLM solo propone `formal`. Nunca decide SAT/UNSAT, nunca marca `approved`, nunca produce código.
- Variante B del eval (LLM-only judge): devuelve `{ conflict: boolean, involved_ids: string[] }` con su propio schema Zod.

## 6. Errores: fail closed, sin fallbacks

- `try/catch` solo en dos fronteras: la carga de archivos de `corpus/` y la llamada al LLM. Ahí el error se convierte en `PARSE_ERROR` o `NEEDS_REVIEW` conservando el mensaje original. En el resto del código, el error se propaga.
- Si la extracción LLM falla, el requisito queda `pending`. La UI muestra fixtures revisadas solo si el usuario elige el modo `fixtures`, nunca como respaldo automático.
- No hay retries, caché, feature flags, configuración dinámica ni clases abstractas. Log: un JSON por ejecución en `runs/<run_id>.json` (`stage`, `latency_ms`, `tokens`, `status`).

## 7. Datos

**Estrategia: sintéticos anclados.** Cada requisito es `anchored` (paráfrasis de un requisito público real, citado en `source.ref`) o `synthetic` (escrito para el demo, con la razón en `source.note`). Los conflictos se inyectan a propósito y quedan declarados. No se copia texto literal de las fuentes.

**Fuentes de anclaje:** GPCA Safety Requirements (Jetley & Jones, 2007; 97 requisitos), vía materiales públicos de UPenn PRECISE: SR 1.4.3 (sin bolo en alarma), SR 1.5.6 (alarma de reservorio vacío), SR 2.2.4 (alerta por inactividad en programación) y la parada inmediata por falla. Los valores simbólicos de la fuente (`t`, `y`) se instancian con números propios, y la instanciación queda explicada en `note`.

**Corpus base** (`corpus/`): 9 requisitos, 2 axiomas, 5 escenarios, 2 interpretaciones, 2 snapshots y 2 inválidos.

| Id | Tipo | Rol en el demo |
|---|---|---|
| REQ-001 | synthetic | Alarma de oclusión ≤ 5 s; lado A del conflicto |
| REQ-002 | synthetic | Silencio de alarmas en los primeros 10 s de calibración; conflicto inyectado |
| REQ-003 | anchored SR 1.4.3 | Sin bolo mientras hay alarma |
| REQ-004 | anchored SR 1.5.6 | Alarma de reservorio vacío ≤ 1 s |
| REQ-005 | anchored (falla) | Parada inmediata ante falla |
| REQ-006 | synthetic | Sin bombeo en calibración; justifica AX-002 |
| REQ-007 | synthetic | Objetivo de vacuidad: disparador inalcanzable |
| REQ-008 | anchored SR 2.2.4 | Sin formalizar a propósito → `NEEDS_REVIEW` |
| REQ-009 | synthetic | Negativo no trivial de equivalencia |

**Gold** (`tests/gold/cases.json`): 11 casos (G01–G11) con positivos y negativos. Incluye la frontera exacta (G03: alarma en t=10 s), el truncamiento en el horizonte (G04), el `NEEDS_REVIEW` (G05) y el `PARSE_ERROR` (G11).

**Mutaciones** (`tests/gold/mutations.json`, generado por `gen-mutations.mjs`): 72 variantes de la familia REQ-001 × REQ-002 × escenario (30 UNSAT, 42 SAT). Varían el deadline, el bound, la ventana de silencio, el momento de la oclusión y la entrada a calibración. La etiqueta sale de una fórmula cerrada, no de Z3, para que el eval no califique al solver con el solver. Cada mutación corre sobre el corpus base completo, con REQ-001 y REQ-002 reemplazados y el escenario `SCN` construido desde sus campos: `NORMAL` en `[0,e)`, `CALIBRATION` en `[e,calEnd)`, `NORMAL` en `[calEnd,20)` y la oclusión en `[t,t+1)`.

**Verificación previa:** un oráculo BMC independiente en Python (no incluido en el repo) reproduce los 11 casos y las 72 etiquetas.

**Aprobación:** los requisitos llegan con `status: "pending"`. Simón los revisa con `REVIEW.md` y aprueba los que acepta. El gold asume aprobados REQ-001…007 y REQ-009, con REQ-008 siempre pendiente.

## 8. Harness

- **Guías:** `CLAUDE.md` (solo lo no obvio), este SPEC, tests gold.
- **Sensores computacionales:**
  - Stop hook `scripts/gate.sh`: typecheck, lint, test, knip. Si falla, devuelve exit 2 y el turno no termina.
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
| 04 | `server.ts`, `apps/web` | Storyboard de 3 min de punta a punta en local |
| 05 | Deploy en Render | El link público reproduce el storyboard |

Prompt por etapa: *"Implementa la etapa NN de SPEC.md. Corre `scripts/gate.sh` y muestra su salida. Al terminar, usa el subagente scope-reviewer sobre el diff."*
