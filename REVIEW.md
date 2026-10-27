# Revisión del corpus CGM (Simón)

Claude escribió este borrador y un oráculo independiente lo verificó: G01–G11 y las 84 mutaciones coinciden. Tú apruebas. Nada entra al solver sin tu aprobación.

## Requisitos

| Id | Texto (resumen) | Lectura formal | ¿OK? |
|---|---|---|---|
| REQ-101 | Glucosa ≤ 55 → alerta Urgent Low en ≤ 5 min, cualquier modo | ANY · urgent_low · within 300 s inclusive · urgent_low_alert | [ ] |
| REQ-102 | Sin alertas de glucosa en los primeros 30 min (calentamiento) | WARMUP [0,1800) · always · ¬urgent_low_alert | [ ] |
| REQ-103 | Sin valores de glucosa durante el calentamiento | WARMUP · always · ¬glucose_shown | [ ] |
| REQ-104 | En uso activo, transmitir una lectura al menos cada 5 min — 21 CFR 862.1355(b)(2) | ACTIVE · always disparado · within 300 s exclusive · reading_sent | [ ] |
| REQ-105 | Sin datos 10 min → alerta Signal Loss en ≤ 1 min — (b)(1)(vii) | ACTIVE · data_gap · within 60 s inclusive · signal_loss_alert | [ ] |
| REQ-106 | Sensor vencido → no mostrar glucosa — (b)(5) | EXPIRED · always · ¬glucose_shown | [ ] |
| REQ-107 | Urgent low con sensor vencido → alerta (objetivo de vacuidad) | EXPIRED · urgent_low · within 300 s · urgent_low_alert | [ ] |
| REQ-108 | El etiquetado describe tasas de alertas — (b)(7)(iv) | **sin formalizar**: queda `pending` | [ ] |

Decisiones de modelado:
- Los umbrales de 5 min, 10 min y 1 min son nuestros; la regulación no los fija. Así lo dice cada `source.note`.
- REQ-101 se ancla en el resumen 510(k) del FreeStyle Libre 3: la alerta Urgent Low es obligatoria y no se puede apagar.
- **El conflicto G01 es realista.** Los CGM reales no dan lecturas durante el calentamiento y lo resuelven con etiquetado ("use su glucómetro"). El snapshot v2 muestra justo esa corrección: limitar REQ-101 a `ACTIVE`.
- AX-101: el calentamiento dura exactamente 30 min. AX-102: un sensor vencido no mide glucosa.

## Gold

- `tests/gold/cases.json`: G01–G11. Revisa los `why`.
- `tests/gold/mutations.json`: lo genera `node tests/gold/gen-mutations.mjs`. Revisa la regla del comentario inicial.
- `tests/gold/obligations.json`: 27 párrafos hoja de 21 CFR 862.1355.
  - **19 evidence:** estudios clínicos, fabricación, interferencias, usabilidad.
  - **3 behavior:** (b)(1)(vii) → REQ-105, (b)(2) → REQ-104, (b)(5) → REQ-106.
  - **5 labeling:** solo (b)(7)(iv) tiene requisito (REQ-108). Los otros 4 son gaps que el agente debe detectar.

## Aprobar

```bash
node -e '
const fs=require("fs");
for (const id of ["REQ-101","REQ-102","REQ-103","REQ-104","REQ-105","REQ-106","REQ-107"]) {
  const p=`corpus/requirements/${id}.json`, r=JSON.parse(fs.readFileSync(p));
  fs.writeFileSync(p, JSON.stringify({...r,status:"approved",approved_by:"simon"},null,2)+"\n");
}'
grep -l '"pending"' corpus/requirements/*.json   # debe listar solo REQ-108
```
