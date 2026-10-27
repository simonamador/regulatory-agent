# rqaudit

Demo: auditor de consistencia lógica para requisitos de un dispositivo médico ficticio. El LLM llena una plantilla tipada; Z3 decide sobre trazas acotadas.
`SPEC.md` es la fuente de verdad técnica. Implementa solo la etapa que se indique.

## Comandos
- Setup: `pnpm install`
- Gate (lo mismo que corre el Stop hook): `scripts/gate.sh`
- Un test: `pnpm --filter @rqaudit/core vitest run checks -t scenario`
- Dev: `pnpm dev` (api + web) · Eval: `pnpm eval`

## Lo que no es obvio en este repo
- El código es la mínima implementación que pasa `tests/gold/`. Una función existe porque un test, la API o la UI la llaman; un helper con un solo caller va inline.
- Fail closed: los errores se propagan. `try/catch` solo en la carga de `corpus/` y en la llamada al LLM (SPEC §6). Un resultado dudoso es `UNKNOWN` o `NEEDS_REVIEW`, nunca un default favorable.
- `tests/gold/` y `corpus/` son la especificación y son de solo lectura. Si un test gold parece incorrecto, detente y explícalo; no lo rodees.
- Borrar el código que la etapa vuelve obsoleto es parte de la tarea.
- `z3-solver`: `init()` es async y pesado. Un solo `Context` por proceso (servidor, archivo de test o CLI). Los CLIs terminan con `process.exit`, porque los workers de Z3 mantienen vivo el proceso.
- BMC: una obligación `within T` disparada cerca del horizonte no restringe nada (SPEC §3). Olvidarlo produce UNSAT espurios. No se descarta en silencio: si el disparador es forzado, sale en `unverified` (SPEC §4).
- El horizonte, el tick y los modos salen de `signals.json`; ningún número del modelo va escrito a mano.
- Render inyecta `PORT`; Express lo lee de ahí.
- `tests/gold/gen-mutations.mjs` es un script suelto de Simón: knip debe ignorar `tests/gold/**`, no hay que borrarlo ni importarlo.
- Los tests de aceptación leen `tests/gold/*.json` desde `packages/core/test/`; el JSON es la especificación y el test solo la recorre.

## Al terminar
Muestra la salida de `scripts/gate.sh`, no un resumen de que pasó.
