# Sesión única (3h): recorrido completo por el hardware de la Game Boy

**Dirigido a:** estudiantes de FP de Informática (DAM / DAW / ASIR / SMR)
**Duración:** 3 horas en una sola sesión (pensada como sesión introductoria o de repaso general, tocando todos los subsistemas antes de profundizar en cada uno por separado en las sesiones de la hoja de tareas por bloques).
**Material necesario:** el emulador (`index.html` + JS), un ROM homebrew legal que use MBC1 o MBC3 (ver `README.md`, sección *Further reading*; recomendado un juego con scroll, sonido y guardado, para poder tocar todos los subsistemas), navegador moderno.
**Formato de entrega:** un único documento (Word, PDF o Markdown) con una sección por fase, siguiendo el mismo orden que esta hoja.

## Objetivos de la sesión

Al terminar, cada estudiante debería poder explicar con sus propias palabras cómo se relacionan los 8 subsistemas de una Game Boy (CPU, memoria, vídeo, MBC, timers, joypad, interrupciones y sonido) y haber usado al menos una vez cada herramienta de depuración del emulador.

## Antes de empezar

- La interfaz tiene dos columnas de pestañas:
  - **Debug Tools** (izquierda): `Registers`, `RAM Editor`, `Mem Scanner`, `Interrupts`, `Trace`, `Event Log`, `Stack`, `Disasm`, `Mem Map`, `MBC Banks`. Hoy usaremos todas menos `Event Log`, que queda para las sesiones por bloques.
  - **Visual Tools** (derecha): `Layers`, `Scanline Timeline`, `Oscilloscope`, `Palettes`, `Sprite Sheet`, `Sprites (OAM)`, `Tile Map`, `Inspector`.
- El interruptor **Play/Debug** de la barra superior cambia entre jugar normal y modo depuración (pausado). El interruptor **Step**, justo al lado, hace que un ROM recién cargado se quede pausado en la primera instrucción en lugar de arrancar en Play. Los botones "Step", "Step Line", "Step Mode" (avanza hasta el siguiente cambio de modo de la PPU), "Step Frame" y "Step 1s" controlan la velocidad de ejecución paso a paso, y solo están activos en modo Debug.
- El menú **Panels** de la barra superior permite ocultar/mostrar los paneles Debug Tools, Visual Tools y Frame Activity si necesitas más espacio en pantalla.
- Esta sesión está pensada para ir con el reloj delante: si te atascas en una pregunta, anota la duda y sigue — es mejor completar el recorrido entero que quedarse perfeccionando una fase.

> ⚠️ **Aviso:** el emulador incluye un tope de uso continuo con fines educativos: la insignia junto a "Load ROM" cuenta el tiempo que el juego lleva en modo Play y, pasado un umbral, avisa con un `alert()` y termina recargando la página automáticamente (perdiendo el estado en memoria). El tiempo en modo Debug/pausado no cuenta para ese tope, así que trabaja en Debug siempre que puedas y usa "💾 Save" / "⬇ Export .json" antes de dejar el juego corriendo un buen rato en Play, por si la página se recarga sola.

---

## Fase 1 — Arranque y primer contacto

- [ ] Carga un ROM homebrew legal. Identifica en la interfaz las dos columnas de pestañas descritas arriba.
- [ ] Comprueba en la barra superior el interruptor de núcleo **GB / GBC**: déjalo en el que corresponda a tu ROM (si tu ROM es GBC-only, el núcleo GB no la podrá ejecutar correctamente).
- [ ] Deja correr el juego en modo Play unos segundos y confirma que los controles responden (Flechas = D-Pad, Z = A, X = B, Enter = Start, Shift = Select).

**Anota:** nombre del ROM, mapper que usa (lo verás en la pestaña `MBC Banks` en cuanto lo cargues), núcleo usado (GB o GBC) y una frase describiendo qué tipo de juego es.

---

## Fase 2 — CPU: ejecutar instrucciones

- [ ] Activa el modo Debug y pausa. Abre `Trace`. Ejecuta 5 instrucciones con el botón "Step" (una instrucción de CPU cada vez, distinto de "Step Mode", que avanza hasta el siguiente cambio de modo de la PPU) y anota, para cada una: dirección (`PC`), instrucción, registro(s) que cambia, flags afectados. Usa el panel `Registers` para confirmar.
- [ ] Localiza en la traza un salto condicional (`JP`, `JR` o `CALL` con condición, p. ej. `JR NZ`). Explica en 2-3 líneas qué papel juegan los flags `Z N H C` en si el salto se produce.
- [ ] Abre `Stack` y localiza una instrucción `CALL` o `RST` reciente. ¿Qué dirección de 16 bits se ha guardado en la pila?

**Anota:** tabla de las 5 instrucciones + explicación del salto condicional + qué viste en la pila.

---

## Fase 3 — Memoria: un único mapa de direcciones

- [ ] Abre `Mem Map`. Identifica dónde están ROM banco 0, ROM banco N, VRAM, RAM de cartucho, WRAM, OAM, I/O y HRAM. Deja correr el juego un momento y observa qué región parpadea más (última lectura/escritura del CPU).
- [ ] Abre `RAM Editor` y localiza `LCDC` (`0xFF40`). Cambia manualmente un bit y observa el efecto en pantalla; luego deshaz el cambio o recarga el ROM.
- [ ] Abre `Mem Scanner` y localiza en memoria un contador visible en pantalla (vidas, monedas, tiempo o puntuación — lo que tenga tu ROM). Haz un "New Scan" de tipo *Exact value* con el valor actual, deja que cambie el valor en el juego, y usa "Next Scan" con el nuevo valor para ir descartando candidatos hasta quedarte con una o pocas direcciones. Si tu ROM no tiene ningún contador así, usa *Unknown initial value* y observa cómo se reduce igualmente la lista de candidatos.
- [ ] En 3-4 líneas: ¿por qué escribir en `0xFF00` (joypad) no es "lo mismo" que escribir en una celda de RAM normal, aunque para la CPU sea la misma operación (`LD`)?

**Anota:** qué bit de `LCDC` cambiaste y su efecto + la dirección (o direcciones) que encontraste con `Mem Scanner` y a qué contador correspondía + la explicación del joypad.

---

## Fase 4 — Vídeo: de bytes a píxeles

- [ ] Con el juego pausado, abre `Tile Map` (rejilla 32×32) y `Inspector` (un tile concreto). En 2-3 líneas, explica la diferencia entre **tile** (dibujo 8×8) y **tilemap** (qué tile va en cada casilla).
- [ ] En `Inspector`, navega hasta un tile de un sprite o de la fuente/HUD del juego (usa "Prev"/"Next" o pega una dirección de `0x8000` en adelante). Elige un color de la paleta de 4 tonos y pinta a mano un par de píxeles sobre el tile (clic o arrastrar en el lienzo 8×8). Comprueba en pantalla, en `Tile Map` o en `Sprite Sheet`, dónde aparece ese cambio reflejado en el juego. Termina con "Clear" o recargando el ROM para dejarlo como estaba.
- [ ] Abre `Sprites (OAM)` y cuenta cuántos sprites hay activos en el frame actual. Abre `Palettes` y anota los valores de `BGP`.
- [ ] En `RAM Editor`, cambia `SCX` o `SCY` (scroll de fondo) y describe el efecto.
- [ ] Abre `Scanline Timeline`. ¿Cuántas líneas tiene un frame completo y cuántas son visibles? ¿Qué ventana de tiempo (V-Blank) usan los juegos para actualizar la memoria de vídeo sin que se note?

**Anota:** diferencia tile/tilemap + qué tile editaste con `Inspector` y dónde se vio el cambio + nº de sprites + efecto del scroll + explicación de V-Blank.

---

## Fase 5 — Cartuchos con truco: bank-switching

- [ ] Abre `MBC Banks`. Observa qué banco de ROM está activo ahora mismo.
- [ ] Juega hasta provocar un cambio de nivel, mapa o menú, y observa cómo cambian los bancos activos en la rejilla (o en el registro de escrituras debajo). Anota qué estaba pasando en el juego en ese momento.
- [ ] En 4-5 líneas: si la CPU solo direcciona `0x0000`–`0xFFFF` (64 KB), ¿cómo puede un cartucho MBC ofrecer varios megabytes de ROM? Explica la idea de "ventana fija + ventana intercambiable".

**Anota:** el momento de cambio de banco observado + la explicación de la ventana fija/intercambiable.

---

## Fase 6 — Timers y Joypad

- [ ] En `RAM Editor`, localiza los registros `DIV`, `TIMA`, `TMA` y `TAC`. Observa cómo `DIV` incrementa constantemente mientras el juego corre.
- [ ] En 2-3 líneas: ¿qué diferencia hay entre `DIV` (siempre corriendo) y `TIMA` (configurable, y que puede disparar una interrupción al desbordar)?
- [ ] Pulsa un botón y observa el registro del joypad (`0xFF00`) en `RAM Editor`. ¿Qué bits cambian al pulsar/soltar?

**Anota:** diferencia DIV/TIMA + qué bits del joypad cambian.

---

## Fase 7 — Interrupciones

- [ ] Abre `Interrupts` y localiza `IE` (`0xFFFF`), `IF` (`0xFF0F`) e `IME`.
- [ ] En 2-3 líneas: ¿por qué hacen falta *dos* registros (`IE` e `IF`) y no basta con uno?
- [ ] Provoca una interrupción de Joypad (pulsando un botón en modo Debug) y observa en `Trace` a qué dirección salta el CPU justo después, y qué pasa con `IME`.

**Anota:** explicación de `IE`/`IF` + la dirección de salto observada.

---

## Fase 8 — Sonido: APU

- [ ] Sube el volumen (control de audio junto a la pantalla del emulador) y deja correr el juego con sonido activado. Abre `Oscilloscope` y observa la forma de onda mientras suena música o un efecto.
- [ ] En 2-3 líneas: ¿qué canal(es) de los 4 (CH1/CH2 pulso, CH3 onda personalizada, CH4 ruido) parece estar sonando ahora mismo, según lo que ves en el osciloscopio?

**Anota:** qué canal(es) identificaste y por qué.

---

## Fase 9 — Síntesis: el ciclo completo

- [ ] En un único diagrama (a mano o con cualquier herramienta), dibuja cómo se relacionan CPU, MMU, PPU, Timer, APU y Joypad alrededor del bus de memoria compartido. Indica qué marca el ritmo (~4.194304 MHz) y cómo ese ritmo se traduce en ciclos de PPU/Timer/APU por cada instrucción del CPU.
- [ ] En 5-6 líneas, con tus propias palabras y sin copiar el README: ¿qué es un ordenador, a partir de lo que has visto hoy en los 8 subsistemas (CPU, memoria, vídeo, MBC, timers, joypad, interrupciones, sonido)?

**Anota:** diagrama + texto de síntesis.

---

## Fase 10 — Cierre

- [ ] Revisa las notas de las 9 fases anteriores y compón el documento de entrega único, con una sección por fase en el mismo orden.
- [ ] Pregunta abierta para comentar en clase: de los 8 subsistemas recorridos hoy, ¿cuál te ha costado más entender y por qué?

**Entrega final:** documento único con las 9 fases (Fase 1 a Fase 9) completas, en el orden de esta hoja.

---

## Nota legal

Usa únicamente ROMs homebrew de licencia libre o dominio público (ver enlaces de itch.io en el `README.md` del proyecto). No se debe usar ni distribuir ROMs comerciales. El propio emulador comprueba cada ROM cargada contra una lista de juegos comerciales conocidos y bloquea su carga si coincide; esto es un apoyo técnico, no un sustituto de elegir bien el ROM de partida.
