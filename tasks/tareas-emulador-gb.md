# Tareas prácticas: explorando una computadora real con el emulador de Game Boy

**Dirigido a:** estudiantes de FP de Informática (DAM / DAW / ASIR / SMR)
**Material necesario:** el emulador (`index.html` + JS), un ROM homebrew legal (ver `README.md`, sección *Further reading*), navegador moderno (Chrome, Firefox o Edge recientes).
**Duración estimada total:** 2 sesiones de 2 horas.
**Formato de entrega:** salvo que se indique otra cosa, cada entrega es un documento (Word, PDF o Markdown) o fotos/capturas legibles, subido donde indique el profesor.

## Cómo usar esta hoja de tareas

- Cada **Bloque** corresponde aproximadamente a una sesión.
- Dentro de cada bloque hay tres tipos de tarea:
  - **Observación** — mirar y entender algo que ya funciona.
  - **Manipulación** — cambiar algo a propósito y describir el efecto.
  - **Entrega** — documentar lo aprendido en un formato concreto.
- Las tareas marcadas **(Ampliación)** son opcionales, para quien vaya sobrado de tiempo o quiera profundizar. No son obligatorias para aprobar el bloque.
- La interfaz del emulador tiene dos columnas de pestañas: la de la izquierda (**Debug Tools**) — `Registers`, `RAM Editor`, `Interrupts`, `Trace`, `Stack`, `Disasm`, `Mem Map`, `MBC Banks` — y la de la derecha (**Visual Tools**) — `Layers`, `Scanline Timeline`, `Oscilloscope`, `Palettes`, `Sprite Sheet`, `Sprites (OAM)`, `Tile Map`, `Inspector`. Cuando una tarea diga "abre la pestaña X", es una de estas.
- El interruptor Debug/Play cambia entre jugar normal y modo depuración (necesario para pausar, avanzar paso a paso, etc.). Los botones "Step", "Step Line", "Step Frame" y "Step 1s" controlan la velocidad de ejecución paso a paso.

---

## Bloque 0 — Puesta en marcha

**Objetivo:** localizar las herramientas antes de usarlas.

- [ ] Abre `index.html` en el navegador. Arrastra un ROM homebrew legal (recomendado: alguno pequeño de los enlazados en el `README.md`).
- [ ] Activa el modo Debug (interruptor arriba, Play/Debug). Localiza en la interfaz: la pestaña `Trace`, la pestaña `Mem Map`, la pestaña `MBC Banks` y el panel de registros (`Registers`).
- [ ] Sin tocar nada más, deja correr el juego 30 segundos en modo Play. Anota qué ves en pantalla y qué controles responden (recuerda: Flechas = D-Pad, Z = A, X = B, Enter = Start, Shift = Select).

**Entrega:** captura de pantalla + 3 líneas describiendo qué pestañas identificas y para qué crees que sirve cada una.

---

## Bloque 1 — El CPU: qué es "ejecutar una instrucción"

**Objetivo:** entender que un programa en ejecución es solo "leer byte → decodificar → cambiar estado → avanzar PC", repetido millones de veces por segundo.

**Antes de empezar, recuerda:** el CPU (LR35902) tiene 8 registros de 8 bits (`A B C D E H L` + flags), dos de 16 bits (`SP`, `PC`) y 4 bits de flags: `Z` (zero), `N` (resta), `H` (half-carry), `C` (carry).

- [ ] Pon el emulador en modo Debug y pausa la ejecución. Abre la pestaña `Trace`.
- [ ] Usa el botón "Step" para ejecutar 10 instrucciones una a una. Para cada una, anota en una tabla: dirección (`PC`), instrucción decodificada, qué registro(s) cambia, qué flags afecta. Compara con el panel `Registers` para confirmar los cambios.
- [ ] Abre la pestaña `Disasm` y compárala con `Trace`: ambas muestran instrucciones decodificadas, pero una muestra el código tal y como está en memoria (estático) y la otra muestra lo que realmente se ha ido ejecutando (histórico). Explica con tus palabras la diferencia.
- [ ] En el código fuente (ver página fuente / archivo JS), busca la función `disassembleBytes`. No hace falta entender cada línea — explica con tus palabras su propósito general.
- [ ] Busca en la traza una instrucción de salto condicional (`JP`, `JR` o `CALL` con condición, p. ej. `JR NZ`, `JP Z`). Explica qué papel juegan los flags `Z N H C` en si el salto se produce o no.

**Entrega:** tabla de las 10 instrucciones + explicación Trace vs. Disasm + explicación del salto condicional (máx. media página).

**Pregunta de reflexión:** si el CPU solo sabe "leer la siguiente dirección y ejecutar lo que hay ahí", ¿cómo sabe el ordenador *cuándo parar*? ¿Alguna vez para de verdad?

**(Ampliación):** localiza en la traza una instrucción `CALL` y su `RET` correspondiente. Abre la pestaña `Stack` antes y después de cada una. ¿Qué valor de 16 bits aparece o desaparece en la cima de la pila? ¿Por qué crees que la pila del Game Boy "crece hacia abajo" (cada `PUSH` decrementa `SP`)?

---

## Bloque 2 — Memoria: todo vive en el mismo mapa

**Objetivo:** entender que RAM, ROM y hardware comparten un único espacio de direcciones de 16 bits.

- [ ] Abre la pestaña `Mem Map` (mapa de memoria interactivo, `0x0000`–`0xFFFF`). Identifica visualmente dónde empieza y termina cada región (ROM banco 0, ROM banco N, VRAM, RAM de cartucho, WRAM, OAM, I/O, HRAM). Fíjate en que la barra que corresponde a la última lectura/escritura del CPU parpadea en blanco: deja correr el juego un momento y observa qué región se ilumina más.
- [ ] Copia la tabla de memoria del `README.md` y complétala con una columna extra: "¿qué pasa si escribo aquí mientras el juego corre?" (una frase por región, con tus propias palabras).
- [ ] Abre la pestaña `RAM Editor`. Localiza el registro `LCDC` (`0xFF40`) entre los registros de I/O. Cambia manualmente un bit (por ejemplo, el que activa/desactiva los sprites o el fondo) y observa el efecto en pantalla. Anota qué bit cambiaste y qué pasó.
- [ ] Explica por qué escribir en `0xFF00` (registro del joypad) **no** es lo mismo que escribir en una celda de RAM normal, aunque desde el punto de vista de la CPU sea "la misma operación" (un `LD` a una dirección).

**Entrega:** tabla completada + qué bit de `LCDC` cambiaste y su efecto + explicación del punto anterior (5-8 líneas).

**(Ampliación):** en `RAM Editor`, compara el contenido de dos direcciones dentro de la ROM banco N (`0x4000`–`0x7FFF`) antes y después de un cambio de banco (ver Bloque 4). ¿El propio CPU "sabe" que el contenido de esa ventana ha cambiado, o simplemente lee lo que haya en ese momento?

---

## Bloque 3 — Vídeo: de bytes a píxeles

**Objetivo:** entender que una imagen en pantalla es el resultado de interpretar datos crudos, no algo "especial".

- [ ] Con el juego pausado, abre la pestaña `Tile Map` para ver la rejilla 32×32 y la pestaña `Inspector` para examinar un tile concreto. Dibuja a mano (en papel o Excel) el patrón 8×8 de un tile a partir de los bytes que ves en el `Inspector`.
- [ ] Explica la diferencia entre **tile** (el dibujo de 8×8, visible en `Sprite Sheet`/`Inspector`) y **tilemap** (la rejilla 32×32 que dice qué tile va en cada casilla, visible en `Tile Map`). ¿Por qué separar estos dos conceptos ahorra memoria frente a guardar la pantalla entera píxel a píxel?
- [ ] Abre la pestaña `Sprites (OAM)` para ver los sprites activos (hasta 40, máx. 10 por línea) y la pestaña `Palettes` para ver `BGP`/`OBP0`/`OBP1`.
- [ ] En `RAM Editor`, localiza `SCX`/`SCY` (scroll de fondo) y `WX`/`WY` (posición de ventana). Cambia sus valores y describe el efecto visual.
- [ ] Abre la pestaña `Scanline Timeline` y el `README.md`: ¿cuántas líneas tiene un frame completo y cuántas son visibles? ¿Qué pasa durante las líneas no visibles (V-Blank)? ¿Por qué es un buen momento para que el juego actualice cosas en memoria?

**Entrega:** dibujo del tile + respuestas a las 3 preguntas.

**(Ampliación):** activa el interruptor `Layers` (arriba, junto a los controles de step) y observa cómo se resaltan fondo, ventana y sprites por separado sobre la pantalla. ¿Qué capa desaparece si desactivas el bit correspondiente en `LCDC`?

---

## Bloque 4 — Cartuchos con truco: bank-switching (MBC)

**Objetivo:** entender cómo un cartucho "engaña" a una CPU de 16 bits para ofrecerle más memoria de la que puede direccionar de golpe.

- [ ] Usa un ROM que use MBC1 o MBC3 (ver tabla "MBC reference" del `README.md`). Abre la pestaña `MBC Banks`.
- [ ] Observa cómo cambian los bancos activos (resaltados en la rejilla de bancos ROM/RAM) mientras el juego progresa (cambio de nivel, de mapa, apertura de menú, etc.). Anota al menos 2 momentos en los que veas un cambio de banco — puedes usar el registro de escrituras (debajo de la rejilla) para verlo — y qué estaba pasando en el juego en ese instante.
- [ ] Con la tabla "MBC reference" del `README.md` delante, responde: si la CPU solo puede direccionar `0x0000`–`0xFFFF` (64 KB), ¿cómo puede un juego de MBC5 tener hasta 8 MB de ROM? Explica la idea de "ventana fija (`0x0000`-`0x3FFF`) + ventana intercambiable (`0x4000`-`0x7FFF`)".
- [ ] **(Ampliación)** Busca en el código fuente el manejo de escrituras a direcciones de control del mapper dentro de la clase `MMU`. ¿Qué ocurre cuando el juego escribe en esas direcciones? (no hace falta leer todo el código, con localizar el bloque y describir su función basta).

**Entrega:** las 2 observaciones (con captura del registro de escrituras si es posible) + la explicación de la ventana fija/intercambiable (máx. media página).

---

## Bloque 5 — Interrupciones: cuando el CPU se interrumpe a sí mismo

**Objetivo:** entender el concepto de interrupción sin necesidad de hablar de sistemas operativos todavía.

- [ ] Abre la pestaña `Interrupts` y localiza los registros `IE` (`0xFFFF`), `IF` (`0xFF0F`) y el flag interno `IME` (también visible en `Registers`).
- [ ] Explica con tus palabras por qué se necesitan *dos* registros (`IE` e `IF`) y no basta con uno solo. Pista: uno dice "qué me interesa" y el otro "qué ha pasado".
- [ ] Provoca (jugando, en modo Debug con Step/Step Frame) al menos una interrupción de Joypad (pulsa un botón) y observa en `Trace` qué ocurre en el CPU justo después: ¿a qué dirección salta (el *vector* de interrupción)? ¿qué pasa con `IME`?
- [ ] Investiga qué hace `EI` según el `README.md` (efecto retardado a la siguiente instrucción, `eiDelay`). ¿Por qué crees que el hardware real se diseñó así en vez de activar las interrupciones al instante?

**Entrega:** respuestas a las 4 preguntas.

**(Ampliación):** repite el ejercicio con la interrupción de V-Blank (se dispara automáticamente en cada frame, en la línea 144) y compárala con la de Joypad: ¿salta a la misma dirección? ¿por qué cada fuente de interrupción necesita su propio vector?

---

## Bloque 6 — Cierre: reconstruir el ciclo completo

**Objetivo:** unir todas las piezas.

- [ ] En un único diagrama (a mano o con cualquier herramienta), dibuja cómo se relacionan CPU, MMU, PPU, Timer, APU y Joypad alrededor del bus de memoria compartido. Indica quién "marca el ritmo" del reloj (~4.194304 MHz) y cómo se traduce ese ritmo en ciclos de PPU/Timer/APU por cada instrucción del CPU.
- [ ] Escribe un texto de media página explicando, con tus propias palabras y **sin copiar el README**, qué es un ordenador usando lo aprendido.
- [ ] Pregunta abierta para debate en clase: ¿qué tiene de diferente (y qué tiene en común) un PC moderno con esta Game Boy de 1989, más allá de la escala?

**Entrega:** diagrama + texto de cierre.

---

## Nota legal

Usa únicamente ROMs homebrew de licencia libre o dominio público (ver enlaces de itch.io en el `README.md` del proyecto). No se debe usar ni distribuir ROMs comerciales.
