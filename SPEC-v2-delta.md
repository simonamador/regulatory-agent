# SPEC v2 — delta (27-oct-2026)

Este delta se integra en SPEC.md y reemplaza todo lo que lo contradiga. Cambian cuatro cosas: el dispositivo, las unidades de tiempo, el horizonte y el agente.

## A. Dominio: monitor continuo de glucosa (CGM)

- El corpus de la bomba de infusión se reemplaza entero por el corpus CGM: `corpus/` y `tests/gold/`. La bomba queda en el historial de git.
- Vocabulario (`corpus/signals.json`):
  - `tick_s = 60` (1 tick = 1 minuto) y `horizon_ticks = 45` (minutos 0..44).
  - Modos: `WARMUP`, `ACTIVE`, `EXPIRED`.
  - Señales: `urgent_low`, `urgent_low_alert`, `glucose_shown`, `data_gap`, `signal_loss_alert`, `reading_sent`.
- `corpus/regulations/21-CFR-862.1355.txt` es el texto oficial del eCFR (versión 2026-10-01, dominio público). Es la entrada del agente.
- Conflicto central (G01): REQ-101 (la alerta Urgent Low no se puede silenciar, ≤ 5 min) choca con REQ-102 (sin alertas durante el calentamiento de 30 min) si hay glucosa urgentemente baja en ese periodo.

## B. Unidades de tiempo

- Todo dato temporal del corpus va en segundos: `s`, `window_s`, `min_s`, `max_s`, `from_s`, `to_s`.
- El encoder divide por `tick_s`. Si un valor no es múltiplo de `tick_s`, el resultado es `PARSE_ERROR` (G11: REQ-902 con 90 s).
- En §3, "t = 19" pasa a ser `horizon_ticks - 1` (44). Ningún número del modelo va escrito a mano en el código; todo sale de `signals.json`.

## C. Obligaciones no verificadas (reemplaza el truncamiento silencioso)

- Una obligación `within` cuyo `last` supera `horizon_ticks - 1` sigue sin restringir el modelo. Pero `scenario_conflict` con resultado SAT devuelve además `unverified: {requirement, tick}[]`.
- Un par `(requirement, tick)` entra en esa lista si (a) el timing del requisito es `within`, (b) su `last` en ese tick pasa el horizonte, y (c) el disparador se cumple en **todo** modelo de AX ∧ REQ ∧ SCN. Para comprobar (c): un check con la assumption ¬trigger(k) debe dar UNSAT. No se usa el witness.
- La lista va ordenada por requirement y luego por tick. Si el resultado es UNSAT, va vacía.
- Gold: `expected_unverified` en G01–G04 y en cada mutación.

## D. Mutaciones autodescritas

Cada caso de `tests/gold/mutations.json` trae lo que necesita para correr:
- `overrides`: campos de `formal` que se reemplazan, por id de requisito;
- `scenario`: el escenario completo, con sus `facts`;
- `expected_status`, `expected_core` y `expected_unverified`.

El test aplica los overrides sobre el corpus base, corre `scenario_conflict` y compara. No conoce nombres de requisitos ni de modos. Hay 84 casos (58 UNSAT, 26 SAT), verificados con un oráculo independiente.

## E. Agente regulatorio (`apps/api/src/agent.ts`)

**Objetivo:** dado un texto regulatorio, producir un *impact assessment* sobre los requisitos del producto. Cada obligación debe quedar clasificada, citada, mapeada a requisitos y con un veredicto basado en evidencia.

**Bucle:** OpenAI tool calling con el SDK `openai`, un máximo de 12 turnos y temperatura mínima que el modelo permita. El LLM decide clasificación y mapeo. **Los veredictos los calcula el código, nunca el LLM.**

**Herramientas** (deterministas, en `apps/api/src/tools.ts`):
- `get_regulation()` devuelve los párrafos hoja con `{ id, context }`. El parser es determinista y no usa LLM; `context` es el texto de los ancestros más el del propio párrafo.
- `search_requirements(query)` devuelve `{ id, text, status }` de todos los requisitos cuyo texto contiene algún término de la búsqueda. No expone `source` ni `formal`: el mapeo tiene que ser semántico, no copiar trazas.
- `get_requirement(id)` devuelve `{ id, text, status, formal }`.
- `run_audit(requirement_ids)` corre la auditoría de §4 (consistency, scenario_conflict por escenario, vacuity, equivalence) y devuelve los findings que tocan esos ids: core, witness resumido y `unverified`.

**Salida del LLM** (schema Zod, structured output) — un item por párrafo hoja:

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

## F. Etapas restantes

| Etapa | Salida | Hecho cuando |
|---|---|---|
| 05 | Dominio CGM + unidades + `unverified` + mutaciones autodescritas + evals A/B/C con plantillas CGM | Gate verde con G01–G11 y 84 mutaciones; `pnpm eval` v3 y rescore por slices; latencia p95 < 2 s |
| 06 | Agente + herramientas + `pnpm eval:agent` | Gate verde; una corrida real con métricas contra `obligations.json` |
| 07 | Servidor + UI | Storyboard de punta a punta en local |
| 08 | Deploy en Render + video | El link público reproduce el storyboard |
