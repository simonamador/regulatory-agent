# Revisión del corpus (etapa 00, Simón)

Claude escribió este borrador; tú lo apruebas. Nada entra al solver sin tu aprobación.
Antes de abrir Claude Code, revisa que cada lectura formal diga lo mismo que el texto.

## Requisitos

| Id | Texto (resumen) | Lectura formal | ¿OK? |
|---|---|---|---|
| REQ-001 | Oclusión → alarma ≤ 5 s, cualquier modo | ANY · occlusion · within 5 inclusive · alarm | [ ] |
| REQ-002 | Primeros 10 s de calibración sin alarmas | CALIBRATION [0,10) · always · ¬alarm | [ ] |
| REQ-003 | Sin bolo mientras alarma (GPCA SR 1.4.3) | ANY · alarm · always · ¬bolus_delivered | [ ] |
| REQ-004 | Reservorio vacío → alarma ≤ 1 s (GPCA SR 1.5.6) | NORMAL · reservoir_empty · within 1 inclusive · alarm | [ ] |
| REQ-005 | Falla → parar bombeo de inmediato (GPCA) | ANY · fault · within 0 inclusive · ¬pumping | [ ] |
| REQ-006 | Sin bombeo en calibración | CALIBRATION · always · ¬pumping | [ ] |
| REQ-007 | Reservorio vacío en calibración → alarma ≤ 2 s | CALIBRATION · reservoir_empty · within 2 inclusive · alarm | [ ] |
| REQ-008 | Inactividad en programación → alerta (GPCA SR 2.2.4) | **sin formalizar**: debe quedar `pending` | [ ] |
| REQ-009 | Oclusión en NORMAL → parar bombeo ≤ 3 s | NORMAL · occlusion · within 3 inclusive · ¬pumping | [ ] |

Decisiones de modelado que conviene que mires:
- REQ-004: el deadline de 1 s lo pusimos nosotros; GPCA no da ninguno. Lo dice `source.note`.
- REQ-005: "inmediatamente" se modeló como el mismo tick (`within 0`).
- AX-001: la calibración dura entre 10 y 15 s. AX-002: no hay reservorio vacío en calibración. Este último hace inalcanzable a REQ-007, y eso es lo que muestra el demo de vacuidad.

## Anclas

Las anclas GPCA vienen de fuentes secundarias de UPenn: el póster NSF GPCA 2012 y Masci et al. No conseguimos la lista primaria de los 97 requisitos. Si la consigues, verifica la numeración de SR 1.4.3, SR 1.5.6 y SR 2.2.4.

## Gold

- `tests/gold/cases.json`: revisa el campo `why` de cada caso G01–G11.
- `tests/gold/mutations.json`: lo genera `node tests/gold/gen-mutations.mjs`. Revisa la regla del comentario inicial del script, no los 72 casos uno por uno.

## Aprobar

Cuando termines, aprueba todo menos REQ-008, quitando también los ids que rechaces:

```bash
node -e '
const fs=require("fs");
for (const id of ["REQ-001","REQ-002","REQ-003","REQ-004","REQ-005","REQ-006","REQ-007","REQ-009"]) {
  const p=`corpus/requirements/${id}.json`, r=JSON.parse(fs.readFileSync(p));
  fs.writeFileSync(p, JSON.stringify({...r,status:"approved",approved_by:"simon"},null,2)+"\n");
}'
git add -A && git commit -m "corpus: approve reviewed requirements"
```

Si rechazas o cambias un requisito, el gold que dependa de él cambia también. Avísale a Claude (en este chat) para recalcular antes de la etapa 02.
