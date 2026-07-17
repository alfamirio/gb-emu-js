# Tareas prácticas: explorando una computadora real con el emulador de Game Boy

**Dirigido a:** estudiantes de FP de Informática (DAM / DAW / ASIR / SMR)
**Material necesario:** el emulador (`index.html` + JS), un ROM homebrew legal (ver `README.md`, sección *Further reading*), navegador moderno (Chrome, Firefox o Edge recientes).
**Duración estimada total:** 3 sesiones de 2 horas (o 2 sesiones de 3 horas).
**Formato de entrega:** salvo que se indique otra cosa, cada entrega es un documento (Word, PDF o Markdown) o fotos/capturas legibles, subido donde indique el profesor.

## Cómo usar esta hoja de tareas

- Cada **Bloque** corresponde aproximadamente a una sesión.
- Dentro de cada bloque hay tres tipos de tarea:
  - **Observación** — mirar y entender algo que ya funciona.
  - **Manipulación** — cambiar algo a propósito y describir el efecto.
  - **Entrega** — documentar lo aprendido en un formato concreto.
- Las tareas marcadas **(Ampliación)** son opcionales, para quien vaya sobrado de tiempo o quiera profundizar. No son obligatorias para aprobar el bloque.
- La interfaz del emulador tiene dos columnas de pestañas: la de la izquierda (**Debug Tools**) — `Registers`, `RAM Editor`, `Mem Scanner`, `Interrupts`, `Trace`, `Event Log`, `Stack`, `Disasm`, `Mem Map`, `MBC Banks` — y la de la derecha (**Visual Tools**) — `Layers`, `Scanline Timeline`, `Oscilloscope`, `Palettes`, `Sprite Sheet`, `Sprites (OAM)`, `Tile Map`, `Inspector`. Cuando una tarea diga "abre la pestaña X", es una de estas.
- El interruptor **Play/Debug** (barra superior) cambia entre jugar normal y modo depuración (necesario para pausar, avanzar paso a paso, etc.). Junto a él, el interruptor **Step** hace que un ROM recién cargado se quede pausado en la primera instrucción en lugar de arrancar en Play. Los botones "Step", "Step Line", "Step Mode" (avanza hasta el siguiente cambio de modo de la PPU), "Step Frame" y "Step 1s" controlan la velocidad de ejecución paso a paso, y solo están activos en modo Debug.

> ⚠️ **Aviso:** el emulador incluye un tope de uso continuo con fines educativos: la insignia junto a "Load ROM" cuenta el tiempo que el juego lleva en modo Play y, pasado un umbral, avisa con un `alert()` y termina recargando la página automáticamente (perdiendo el estado en memoria). El tiempo en modo Debug/pausado no cuenta para ese tope, así que trabaja en Debug siempre que puedas y usa "💾 Save" / "⬇ Export .json" antes de dejar el juego corriendo un buen rato en Play, por si la página se recarga sola.

- El menú **Panels** de la barra superior permite ocultar/mostrar los paneles Debug Tools, Visual Tools y Frame Activity si necesitas más espacio en pantalla; el panel **Frame Activity** (fuera de las dos columnas de pestañas, debajo de la pantalla) está oculto por defecto y se usa en el Bloque 8.

---

## Bloque 0 — Puesta en marcha

**Objetivo:** localizar las herramientas antes de usarlas.

- [ ] Abre `index.html` en el navegador. Arrastra un ROM homebrew legal (recomendado: alguno pequeño de los enlazados en el `README.md`).
- [ ] Comprueba en la barra superior el interruptor de núcleo **GB / GBC** y déjalo en el que corresponda a tu ROM (una ROM GBC-only no funcionará bien con el núcleo GB).
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
- [ ] Abre la pestaña `Mem Scanner` y localiza en memoria un contador visible en pantalla (vidas, monedas, tiempo o puntuación — lo que tenga tu ROM). Haz un "New Scan" de tipo *Exact value* con el valor actual, deja que ese valor cambie jugando, y usa "Next Scan" con el nuevo valor para ir descartando candidatos hasta quedarte con una o pocas direcciones. Si el valor inicial no lo conoces, usa *Unknown initial value* en su lugar. Anota la dirección (o direcciones) a la que has llegado y a qué contador corresponde.
- [ ] Explica por qué escribir en `0xFF00` (registro del joypad) **no** es lo mismo que escribir en una celda de RAM normal, aunque desde el punto de vista de la CPU sea "la misma operación" (un `LD` a una dirección).

**Entrega:** tabla completada + qué bit de `LCDC` cambiaste y su efecto + dirección(es) encontradas con `Mem Scanner` y a qué corresponden + explicación del punto anterior (5-8 líneas).

**(Ampliación):** en `RAM Editor`, compara el contenido de dos direcciones dentro de la ROM banco N (`0x4000`–`0x7FFF`) antes y después de un cambio de banco (ver Bloque 4). ¿El propio CPU "sabe" que el contenido de esa ventana ha cambiado, o simplemente lee lo que haya en ese momento?

---

## Bloque 3 — Vídeo: de bytes a píxeles

**Objetivo:** entender que una imagen en pantalla es el resultado de interpretar datos crudos, no algo "especial".

- [ ] Con el juego pausado, abre la pestaña `Tile Map` para ver la rejilla 32×32 y la pestaña `Inspector` para examinar un tile concreto. Dibuja a mano (en papel o Excel) el patrón 8×8 de un tile a partir de los bytes que ves en el `Inspector`.
- [ ] Explica la diferencia entre **tile** (el dibujo de 8×8, visible en `Sprite Sheet`/`Inspector`) y **tilemap** (la rejilla 32×32 que dice qué tile va en cada casilla, visible en `Tile Map`). ¿Por qué separar estos dos conceptos ahorra memoria frente a guardar la pantalla entera píxel a píxel?
- [ ] En `Inspector`, navega con "Prev"/"Next" (o pegando una dirección de `0x8000` en adelante) hasta un tile de un sprite o de la fuente/HUD del juego. Elige un color de la paleta de 4 tonos y pinta a mano un par de píxeles sobre el lienzo 8×8 (clic o arrastrar). Comprueba en `Tile Map` o `Sprite Sheet` dónde se refleja el cambio en el juego, y anota la dirección del tile que editaste. Termina con "Clear" o recargando el ROM para dejarlo como estaba.
- [ ] Abre la pestaña `Sprites (OAM)` para ver los sprites activos (hasta 40, máx. 10 por línea) y la pestaña `Palettes` para ver `BGP`/`OBP0`/`OBP1`.
- [ ] En `RAM Editor`, localiza `SCX`/`SCY` (scroll de fondo) y `WX`/`WY` (posición de ventana). Cambia sus valores y describe el efecto visual.
- [ ] Abre la pestaña `Scanline Timeline` y el `README.md`: ¿cuántas líneas tiene un frame completo y cuántas son visibles? ¿Qué pasa durante las líneas no visibles (V-Blank)? ¿Por qué es un buen momento para que el juego actualice cosas en memoria?

**Entrega:** dibujo del tile + dirección y descripción del tile editado en `Inspector` + respuestas a las 3 preguntas.

**(Ampliación):** activa el interruptor **Layers** (menú **View** de la barra superior) y observa cómo se resaltan fondo, ventana y sprites por separado sobre la pantalla. ¿Qué capa desaparece si desactivas el bit correspondiente en `LCDC`? El interruptor **Line**, en el mismo menú, marca sobre la pantalla la línea que se está dibujando ahora mismo — solo se puede activar/desactivar en pausa, así que actívalo con el juego pausado y luego reanuda: verás la marca avanzar en sincronía con el playhead de `Scanline Timeline`.

---

## Bloque 4 — Cartuchos con truco: bank-switching (MBC)

**Objetivo:** entender cómo un cartucho "engaña" a una CPU de 16 bits para ofrecerle más memoria de la que puede direccionar de golpe.

- [ ] Usa un ROM que use MBC1 o MBC3 (ver tabla "MBC reference" del `README.md`). Abre la pestaña `MBC Banks`.
- [ ] Observa cómo cambian los bancos activos (resaltados en la rejilla de bancos ROM/RAM) mientras el juego progresa (cambio de nivel, de mapa, apertura de menú, etc.). Anota al menos 2 momentos en los que veas un cambio de banco — puedes usar el registro de escrituras (debajo de la rejilla) para verlo — y qué estaba pasando en el juego en ese instante.
- [ ] Con la tabla "MBC reference" del `README.md` delante, responde: si la CPU solo puede direccionar `0x0000`–`0xFFFF` (64 KB), ¿cómo puede un juego de MBC5 tener hasta 8 MB de ROM? Explica la idea de "ventana fija (`0x0000`-`0x3FFF`) + ventana intercambiable (`0x4000`-`0x7FFF`)".
- [ ] **(Ampliación)** Busca en el código fuente el manejo de escrituras a direcciones de control del mapper dentro de la clase `MMU`. ¿Qué ocurre cuando el juego escribe en esas direcciones? (no hace falta leer todo el código, con localizar el bloque y describir su función basta).

**Entrega:** las 2 observaciones (con captura del registro de escrituras si es posible) + la explicación de la ventana fija/intercambiable (máx. media página).

---

## Bloque 5 — Timers y Joypad: medir el tiempo y leer al jugador

**Objetivo:** entender que "el tiempo" en el hardware es solo un contador que sube solo, y que "leer al jugador" es solo otro registro mapeado en memoria, con un pequeño truco de multiplexado.

- [ ] Abre la pestaña `RAM Editor` y localiza `DIV` (`0xFF04`), `TIMA` (`0xFF05`), `TMA` (`0xFF06`) y `TAC` (`0xFF07`). Deja correr el juego y observa cómo `DIV` sube constantemente sin que nadie lo controle (escribir cualquier valor en `DIV` lo resetea a 0, no lo fija al valor escrito).
- [ ] Explica con tus palabras la diferencia entre `DIV` (siempre corriendo, no configurable, no genera interrupción) y `TIMA` (solo cuenta si `TAC` lo activa, a una de 4 frecuencias seleccionables, y genera una interrupción de Timer al desbordar `0xFF` → `0x00`, momento en el que se recarga con el valor de `TMA`).
- [ ] Cambia `TAC` para activar el timer a la frecuencia más alta disponible y observa en `RAM Editor` cómo `TIMA` sube mucho más rápido que antes. Deja `TAC` como estaba (o recarga el ROM) al terminar.
- [ ] Con el juego en pausa (modo Debug), pulsa un botón y observa el registro del joypad (`0xFF00`) en `RAM Editor`. ¿Qué bits cambian al pulsar/soltar? (recuerda: en el joypad del Game Boy un bit a **0** significa "pulsado", no a 1 — es lógica activa-baja).
- [ ] El registro del joypad solo tiene 4 bits para los botones en sí, pero hay 8 botones en total (4 direcciones + A/B/Start/Select). Investiga en el `README.md` o en el código cómo resuelve esto el hardware con los bits P14/P15 ("selección de columna") y explica en 3-4 líneas por qué hacen falta dos lecturas distintas del mismo registro en vez de una sola.

**Entrega:** qué observaste en `DIV`/`TIMA`/`TMA`/`TAC` (incluido el efecto de subir la frecuencia en `TAC`) + qué bits del joypad cambian al pulsar cada botón + explicación de P14/P15.

**(Ampliación):** fuerza una interrupción de Timer (`TAC` a la frecuencia más alta, `TMA` a un valor cercano a `0xFF` para que desborde pronto) y localiza en `Trace`/`Interrupts` a qué dirección salta el CPU al dispararse.

---

## Bloque 6 — Interrupciones: cuando el CPU se interrumpe a sí mismo

**Objetivo:** entender el concepto de interrupción sin necesidad de hablar de sistemas operativos todavía.

- [ ] Abre la pestaña `Interrupts` y localiza los registros `IE` (`0xFFFF`), `IF` (`0xFF0F`) y el flag interno `IME` (también visible en `Registers`).
- [ ] Explica con tus palabras por qué se necesitan *dos* registros (`IE` e `IF`) y no basta con uno solo. Pista: uno dice "qué me interesa" y el otro "qué ha pasado".
- [ ] Provoca (jugando, en modo Debug con Step/Step Frame) al menos una interrupción de Joypad (pulsa un botón) y observa en `Trace` qué ocurre en el CPU justo después: ¿a qué dirección salta (el *vector* de interrupción)? ¿qué pasa con `IME`?
- [ ] Investiga qué hace `EI` según el `README.md` (efecto retardado a la siguiente instrucción, `eiDelay`). ¿Por qué crees que el hardware real se diseñó así en vez de activar las interrupciones al instante?

**Entrega:** respuestas a las 4 preguntas.

**(Ampliación):** repite el ejercicio con la interrupción de V-Blank (se dispara automáticamente en cada frame, en la línea 144) y compárala con la de Joypad: ¿salta a la misma dirección? ¿por qué cada fuente de interrupción necesita su propio vector?

---

## Bloque 7 — Sonido: la APU

**Objetivo:** entender que el sonido, igual que el vídeo, es solo el resultado de otro periférico controlado por registros mapeados en memoria — sin nada especial frente a las demás piezas ya vistas.

- [ ] Sube el volumen (control de audio junto a la pantalla del emulador) y deja correr el juego con sonido activado. Abre la pestaña `Oscilloscope` y observa la forma de onda mientras suena música o un efecto.
- [ ] Explica qué canal(es) de los 4 (CH1/CH2 pulso, CH3 onda personalizada, CH4 ruido) te parece que están sonando ahora mismo, según la forma de onda que ves en el osciloscopio.
- [ ] Abre `RAM Editor` y localiza los registros de control del canal 1: `NR10` (`0xFF10`, sweep), `NR11` (`0xFF11`, duty/length) y `NR12` (`0xFF12`, envolvente de volumen). Mientras algo suene en ese canal, cambia el duty cycle (bits 6-7 de `NR11`) o el volumen inicial (bits 4-7 de `NR12`) y observa el efecto en `Oscilloscope`.
- [ ] Cada canal se activa/desactiva y cambia de volumen a un ritmo distinto (length, sweep, envelope), pero los tres relojes salen de un único contador de 512 Hz llamado "frame sequencer", a su vez derivado del reloj de ~4.194304 MHz de la CPU. En 2-3 líneas, explica con tus palabras cómo un solo contador puede repartir 3 frecuencias distintas (256 Hz para length, 128 Hz para sweep, 64 Hz para envelope) sin necesitar 3 relojes independientes.

**Entrega:** qué canal(es) identificaste y por qué + qué registro cambiaste y su efecto + explicación del frame sequencer.

**(Ampliación):** si tu ROM usa el canal 4 (ruido, `NR41`-`NR44`, `0xFF20`-`0xFF23` — típico en explosiones o efectos de golpe), compara su forma de onda en `Oscilloscope` con la de un canal de pulso (CH1/CH2). ¿En qué se nota a simple vista que uno es ruido y el otro un tono?

---

## Bloque 8 — Cierre: reconstruir el ciclo completo

**Objetivo:** unir todas las piezas.

- [ ] Abre la pestaña `Event Log`. Es un registro unificado de eventos de CPU, PPU, APU, Timer, MBC y del propio emulador (componente "System"), a diferencia de `Trace` (solo CPU, instrucción a instrucción). Ajusta el nivel a "Debug (hardware events)", deja correr el juego unos segundos y localiza en la lista al menos un evento de 3 componentes distintos (por ejemplo, un cambio de banco de `MBC`, un disparo de canal en `APU` y una interrupción de `CPU`). Usa los checkboxes de la izquierda para aislar un componente cada vez si te ayuda a encontrarlos.
- [ ] Activa el panel **Frame Activity** (menú **Panels**, interruptor "Frame", debajo de la pantalla). En el gráfico de la izquierda ("Last N frames"), haz clic en un frame para inspeccionarlo; en el de la derecha ("Anatomy of frame"), localiza al menos un evento (interrupción, DMA, cambio de banco o disparo de APU) y observa si cae cerca de la línea 144 (inicio de V-Blank) o en mitad de las líneas visibles. Haz clic en esa línea concreta en el gráfico para ver el detalle en "Anatomy of line".
- [ ] En un único diagrama (a mano o con cualquier herramienta), dibuja cómo se relacionan CPU, MMU, PPU, Timer, APU y Joypad alrededor del bus de memoria compartido. Indica quién "marca el ritmo" del reloj (~4.194304 MHz) y cómo se traduce ese ritmo en ciclos de PPU/Timer/APU por cada instrucción del CPU.
- [ ] Escribe un texto de media página explicando, con tus propias palabras y **sin copiar el README**, qué es un ordenador usando lo aprendido.
- [ ] Pregunta abierta para debate en clase: ¿qué tiene de diferente (y qué tiene en común) un PC moderno con esta Game Boy de 1989, más allá de la escala?

**Entrega:** los eventos localizados en `Event Log` (con sus 3 componentes) + el evento localizado en `Frame Activity` y en qué línea cayó + diagrama + texto de cierre.

---

## Nota legal

Usa únicamente ROMs homebrew de licencia libre o dominio público (ver enlaces de itch.io en el `README.md` del proyecto). No se debe usar ni distribuir ROMs comerciales. El propio emulador comprueba cada ROM cargada contra una lista de juegos comerciales conocidos y bloquea su carga si coincide; esto es un apoyo técnico, no un sustituto de elegir bien el ROM de partida.
