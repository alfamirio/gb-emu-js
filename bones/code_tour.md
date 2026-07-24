# Tour guiado: un emulador de Game Boy por dentro
### Para SMR (grado medio) y ASIR (grado superior)

---

## Cómo funciona esta actividad

**No vas a escribir código, ni modificarlo, ni ejecutarlo.** Vas a hacer algo
muy parecido a lo que hace cualquier técnico cuando le entregan un programa
que no ha escrito él: **abrirlo, buscar la pieza concreta que le interesa, y
leerla con atención hasta entenderla.**

Todo lo que necesitas es:

- El archivo **`emu-gb-core.js`** abierto en un editor de texto (Bloc de
  notas, Notepad++, VS Code... cualquiera vale) con la función de búsqueda
  activa (`Ctrl+F`).
- Opcionalmente, el archivo `index.html` (solo lo usamos un par de veces).
- Nada más. No hace falta cargar ninguna ROM, no hace falta abrir la consola
  del navegador, no hace falta ejecutar nada.

Cada ejercicio te dice **qué texto buscar** (con `Ctrl+F`) y **qué preguntas
responder** sobre lo que encuentres. Todas las respuestas están **literalmente
escritas** en el archivo, en el código o en sus comentarios — es un ejercicio
de lectura y comprensión, no de programación.

---

## Antes de empezar: vocabulario mínimo

Si ya conoces estos términos, sáltate esta tabla. Si no, tenla a mano durante
todo el tour.

| Término | Qué significa aquí |
|---|---|
| **Bit** | Un 0 o un 1. La unidad más pequeña de información. |
| **Byte** | Un grupo de 8 bits. Puede representar un número de 0 a 255. |
| **Hexadecimal (hex)** | Una forma de escribir números en base 16 en vez de base 10. En el código verás números como `0x8000` — el `0x` solo avisa de que es hexadecimal. No necesitas saber convertirlos a mano; solo reconocer que son números. |
| **Array** | Una lista de valores guardados uno detrás de otro, cada uno con una posición numerada (empezando en 0). En el código verás `new Uint8Array(...)`: es una lista de bytes. |
| **Clase** | En el código, un molde que agrupa datos y funciones relacionadas. Se reconoce porque empieza por la palabra `class`, por ejemplo `class MMU { ... }`. |
| **Método / función** | Una acción que puede hacer una clase. Se reconoce porque tiene un nombre seguido de paréntesis, por ejemplo `step(cycles) { ... }`. |
| **Comentario** | Texto que empieza por `//` o va entre `/* ... */`. El ordenador lo ignora; está ahí solo para que las personas lo lean. **Los comentarios de este archivo son tu mejor pista en casi todos los ejercicios.** |
| **Registro** | Una "casilla" de memoria muy pequeña y muy rápida, dentro del propio procesador (no es la memoria RAM). |
| **Interrupción** | Una señal que dice "para lo que estás haciendo y atiende esto primero". |

---

## 0. El mapa general: 7 piezas, 1 archivo

El propio archivo `emu-gb-core.js` numera sus secciones en los comentarios.
Ábrelo y busca (`Ctrl+F`) cada uno de estos textos **tal cual**:

| # | Busca este texto | Qué pieza real de la Game Boy representa |
|---|---|---|
| 1 | `1. MMU (Memory Management Unit)` | El mapa de memoria: qué hay guardado en cada dirección |
| 2 | `2. CPU (LR35902)` | El procesador: el chip que ejecuta el juego |
| 3 | `3. PPU (graphics)` | El chip de vídeo: dibuja la pantalla |
| 4 | `4. Timer` | El circuito que cuenta el tiempo |
| 5 | `5. Joypad` | Los botones físicos |
| 6 | `6. APU (sound)` | El chip de sonido |
| 7 | `7. GBEmulator (glue)` | La pieza que conecta todas las anteriores |

### Ejercicio 0.1 🟢 (nivel básico)
Busca `class GBEmulator` y mira dentro de su `constructor`. Verás seis líneas
parecidas a `this.mmu = new MMU(this);`. Escribe aquí los **seis** nombres de
propiedad que se crean (por ejemplo, `mmu`) y, al lado de cada uno, de qué
clase es (por ejemplo, `MMU`).

### Ejercicio 0.2 🔵 (nivel avanzado)
Fíjate en que las seis líneas del ejercicio anterior pasan `this` (o, en el
caso de `this.cpu`, `this.mmu`) como argumento al crear cada pieza. Lee los
`constructor` de dos de esas clases (por ejemplo, `PPU` y `Timer`) y busca
dónde guardan ese argumento. ¿Para qué crees que cada pieza necesita guardar
una referencia al resto del sistema (o, al menos, a la MMU)?

---

## 1. MMU — el mapa de memoria

### Contexto (hardware real)
La Game Boy puede señalar direcciones de memoria del `0x0000` al `0xFFFF`
(65.536 direcciones en total). Pero detrás de esas direcciones no hay un solo
bloque de memoria: hay ROM del cartucho, memoria de vídeo, memoria de trabajo,
y también "casillas" que en realidad son botones, temporizador o sonido. La
MMU es la pieza que decide, para cada dirección, **a qué le corresponde
realmente**.

A esto se le llama **E/S mapeada en memoria**: en vez de que el juego tenga
una forma especial de "hablar" con la pantalla o los botones, simplemente lee
y escribe una dirección de memoria como otra cualquiera, y es la MMU quien
por detrás decide qué pasa de verdad.

### Dónde mirar
- Busca `class MMU`. En su `constructor`, fíjate en las líneas con
  `new Uint8Array(...)`: cada una crea un bloque de memoria distinto (`rom`,
  `vram`, `wram`, `oam`, `hram`, `io`).
- Busca `read8(addr)`. Es una lista de comprobaciones `if (addr < ...)` que
  decide en qué región cae una dirección.
- Busca `EMU_CORE_CONFIG.MEMORY` (cerca del principio del archivo). Aquí
  están los límites exactos de cada región de memoria, en hexadecimal.

### Preguntas de comprensión
1. 🟢 Busca `EMU_CORE_CONFIG.MEMORY`. Copia el valor de `ROM0_END` y el valor
   de `ROMX_END`. Según sus nombres, ¿qué franja de direcciones ocupa la ROM
   fija del cartucho, y cuál la ROM "intercambiable"?
2. 🟢 Busca la línea que dice `this.vram = new Uint8Array(...)`. ¿Qué
   constante se usa como tamaño? Búscala en `EMU_CORE_CONFIG.MEMORY` y anota
   su valor.
3. 🔵 Busca el comentario que hay justo encima de `class MMU` (empieza por
   `/* ====... 1. MMU`). Léelo entero. Con tus palabras: ¿qué problema
   resuelve un "Memory Bank Controller" (MBC) cuando un juego pesa más de lo
   que la Game Boy puede direccionar de golpe?

### Ejercicios de lectura
- **1.1** 🟢 Busca el método `_readIO(addr)`. Localiza el bloque `switch
  (reg)`. Copia la línea completa del `case 0x00` y la del `case 0x04`.
  Según el nombre del objeto al que apuntan (`joypad`, `timer`...), ¿a qué
  pieza de hardware real corresponde cada una?
- **1.2** 🟢 Busca el método `loadROM(bytes)` dentro de `class MMU` (hay dos
  métodos con ese nombre en el archivo — asegúrate de estar en la clase
  `MMU`, no en `GBEmulator`). ¿Qué hace la línea `this.io.fill(0)`, según tu
  intuición del nombre `fill`?
- **1.3** 🔵 Busca `_doDMA(val)`. Lee el comentario que tiene justo encima.
  ¿Cuántos ciclos dice que tarda esta operación en el hardware **real**?
  ¿Y cuánto tarda en este emulador, a juzgar por cómo está escrito el bucle
  `for`? Explica con tus palabras la diferencia.

---

## 2. CPU (LR35902) — el procesador

### Contexto (hardware real)
El "LR35902" es el procesador de la Game Boy. Como cualquier procesador,
funciona repitiendo siempre el mismo ciclo, muy rápido: **leer la siguiente
instrucción → averiguar qué significa → ejecutarla → volver a empezar**. Este
ciclo se llama *fetch-decode-execute* ("buscar-decodificar-ejecutar").

El procesador guarda su información en unas pocas casillas muy rápidas
llamadas **registros** (aquí, con los nombres `A B C D E H L`), tiene una
**pila** (para recordar a dónde volver después de una llamada a una
subrutina) y un registro de **flags** (banderas): unos bits que responden a
preguntas como "¿el último resultado fue cero?".

### Dónde mirar
- Busca `class CPU`, y dentro, el método `reset()`. Aquí se inicializan todos
  los registros.
- Busca `step()` (dentro de `class CPU`). Son pocas líneas: es literalmente
  el ciclo fetch-decode-execute.
- Busca `tryDispatchInterrupt()`. Aquí se decide qué pasa cuando otra pieza
  (pantalla, temporizador, botones) necesita "avisar" al procesador.

### Preguntas de comprensión
1. 🟢 Busca el método `step()`. Léelo de arriba a abajo. Ordena estas tres
   acciones tal y como aparecen en el código: **(a)** ejecutar la
   instrucción, **(b)** comprobar si hay una interrupción pendiente, **(c)**
   leer la siguiente instrucción de memoria.
2. 🟢 Busca `tryDispatchInterrupt()`. Localiza la línea que empieza por
   `const vectors = [...]`. Copia los cinco números hexadecimales de esa
   lista.
3. 🔵 Justo encima de esa misma lista hay un comentario que nombra las cinco
   interrupciones en el mismo orden que los cinco números (`VBlank, LCD
   STAT, Timer, Serial, Joypad`). Empareja cada número con su nombre.

### Ejercicios de lectura
- **2.1** 🟢 En el ejercicio anterior identificaste qué número de la lista
  `vectors` corresponde al **Timer**. Ahora ve a la sección 4 (`class
  Timer`) y busca la línea que contiene `requestInterrupt(2)`. ¿El `2` que
  aparece ahí coincide con la posición que le corresponde al Timer en la
  lista `vectors`? (Recuerda: las listas empiezan a contar en la posición 0,
  no en la 1).
- **2.2** 🟢 Busca el método `reset()` de `class CPU`. Localiza la línea que
  asigna un valor a `this.PC`. ¿De dónde saca ese valor (mira el resto de la
  línea)? Busca esa misma constante en `EMU_CORE_CONFIG.BOOT` y copia su
  valor.
- **2.3** 🔵 Busca `_push16(v)` y `_pop16()`. Son dos líneas de código cada
  una. Sin necesidad de entender cada símbolo, fíjate en qué hacen con
  `this.SP` (súmalo o réstalo) en cada una. ¿Por qué crees que una función
  resta 1 a `SP` dos veces y la otra suma 1 dos veces? (pista: relaciona esto
  con la idea de "pila" del vocabulario inicial).

---

## 3. PPU — la pantalla

### Contexto (hardware real)
La pantalla de la Game Boy (160×144 píxeles) no se dibuja entera de golpe:
se genera **fila por fila**, de arriba hacia abajo, muchas veces por segundo.
La pieza que hace ese trabajo se llama PPU (*Picture Processing Unit*, "chip
de vídeo"), y funciona en paralelo al procesador, no dentro de él.

La PPU lee dos zonas de memoria: la **VRAM** (los dibujos pequeños de 8×8
píxeles, llamados *tiles*) y la **OAM** (la posición de hasta 40 objetos
móviles, llamados *sprites*).

### Dónde mirar
- Busca `class PPU`. Dentro, el método `step(cycles)`: controla en qué fase
  de dibujado está la pantalla en cada instante.
- Busca `get lcdc()`, `get ly()` y `get scx()`. Son los registros de vídeo
  reales de la Game Boy, con nombre.
- Busca `EMU_CORE_CONFIG.FRAME`. Aquí están los números de líneas y ciclos.

### Preguntas de comprensión
1. 🟢 Busca `EMU_CORE_CONFIG.FRAME`. Copia el valor de `VISIBLE_LINES` y el
   de `VBLANK_LINES`. Súmalos: ¿cuántas líneas tiene un frame completo en
   total?
2. 🟢 Busca `get ly()`. ¿A qué dirección de memoria apunta (mira el número
   entre corchetes)? El comentario del principio de la sección 3 dice que
   `LY` significa "qué línea se está dibujando ahora mismo". ¿Tiene sentido
   que el juego pueda leer esa dirección para saberlo?
3. 🔵 Busca el método `step(cycles)` de `class PPU`. Localiza el `switch
   (this.mode)`. Hay cuatro casos: `2`, `3`, `0` y `1`. Busca, en el
   comentario que hay justo antes del método, o en los propios comentarios
   dentro de cada `case`, qué fase de dibujado corresponde a cada número.

### Ejercicios de lectura
- **3.1** 🟢 Busca `_checkStatInterrupt(bit)`. Ahora busca, dentro de `class
  PPU`, todas las líneas que contienen `requestInterrupt(1)` (hay varias).
  ¿Todas piden la misma interrupción (el mismo número), aunque ocurran en
  momentos distintos del dibujado? Anota cuántas veces aparece.
- **3.2** 🟢 Busca `getTileColorIndex`. Justo antes de la clase `PPU` hay un
  comentario explicando que cada tile mide 8×8 píxeles y que cada píxel
  puede ser 1 de 4 colores (2 bits por píxel). Haz la cuenta: 8×8 píxeles ×
  2 bits = ¿cuántos bits en total? ¿Cuántos bytes son (recuerda: 1 byte = 8
  bits)?
- **3.3** 🔵 Busca `_mode3Length()`. Lee el comentario que tiene encima.
  Según ese comentario, ¿qué dos cosas hacen que el modo 3 (dibujado de
  píxeles) dure más o menos tiempo en una línea concreta?

---

## 4. Timer — el reloj de la consola

### Contexto (hardware real)
Un temporizador de hardware es de los ejemplos más sencillos de "E/S mapeada
en memoria": es un número que **sube solo**, a un ritmo fijo, sin que el
procesador tenga que hacer nada para ello. El juego puede leer ese número
cuando quiera, para medir cuánto tiempo ha pasado, y puede pedir que se le
avise (con una interrupción) cuando ese número se desborde.

### Dónde mirar
- Busca `class Timer`. Tiene pocas propiedades: `divReg` (sube siempre) y
  `tima`/`tma`/`tac` (un contador que se puede activar o desactivar).
- Busca el método `step(cycles)` de `class Timer`.
- Busca `EMU_CORE_CONFIG.TIMER`.

### Preguntas de comprensión
1. 🟢 Busca `EMU_CORE_CONFIG.TIMER.TIMA_PERIOD`. Copia los cuatro números de
   esa lista.
2. 🟢 Busca el método `step(cycles)` de `class Timer`. Localiza la línea
   `if (this.tac & 0x04)`. Según el comentario que la acompaña ("timer
   enabled"), ¿qué significa que esa condición sea falsa? ¿Qué contador de
   los dos (`div` o `tima`) crees que seguiría subiendo igualmente, y cuál
   se detendría?
3. 🔵 Dentro del mismo `step(cycles)`, busca la línea `if (this.tima === 0)`.
   Lee las dos líneas que vienen justo después. ¿A qué valor se recarga
   `tima` cuando se desborda? ¿Es siempre 0, o depende de otra variable?

### Ejercicios de lectura
- **4.1** 🟢 Busca, dentro de `class MMU`, el método `_writeIO(addr, val)`.
  Localiza el `case 0x04` y el `case 0x05`. Copia ambas líneas. ¿Hacen
  exactamente lo mismo con el valor que llega (`val`), o se comportan de
  forma distinta?
- **4.2** 🟢 Vuelve a `class Timer` y busca la línea con
  `this.emulator.requestInterrupt(2)`. Ahora repasa el ejercicio 2.1 de la
  sección anterior (CPU): confirma que el número `2` que aparece aquí
  coincide con la posición del Timer en la lista `vectors` de
  `tryDispatchInterrupt()`.
- **4.3** 🔵 Busca `EMU_CORE_CONFIG.TIMER.DIV_PERIOD`. Copia su valor. Ahora
  busca, en `step(cycles)` de `class Timer`, el bucle `while` que usa esa
  constante. ¿Qué le pasa a `divReg` cada vez que el bucle se ejecuta una
  vez?

---

## 5. Joypad — los botones

### Contexto (hardware real)
Es el ejemplo más sencillo de "E/S mapeada en memoria": los botones no
avisan al procesador de que alguien los ha pulsado. Es el juego quien, cada
vez que quiere saberlo, **lee una dirección de memoria concreta** (`0xFF00`)
y recibe como respuesta el estado actual de los botones.

### Dónde mirar
- Busca `class Joypad`. Tiene solo dos variables de estado:
  `directionState` y `buttonState`.
- Busca los métodos `write(val)` y `read()`.
- Busca `setButton(bit, pressed, isDirection)`.

### Preguntas de comprensión
1. 🟢 Busca la línea `this.directionState = 0x0F;` dentro del `constructor`
   de `class Joypad`. Lee el comentario que la acompaña. ¿Qué bit representa
   cada dirección (Right, Left, Up, Down)?
2. 🟢 El mismo comentario dice "(0 = pressed)" — es decir, un bit a **0**
   significa "botón pulsado", no a 1 como podría parecer más intuitivo.
   ¿Recuerdas alguna explicación de por qué el hardware real de la Game Boy
   podría funcionar así? (Si no la recuerdas, no pasa nada: anota tu propia
   hipótesis).
3. 🔵 Busca el método `setButton(bit, pressed, isDirection)`. Localiza la
   línea que contiene `requestInterrupt(4)`. Fíjate en la condición `if`
   que la envuelve: `if (pressed && !wasPressed)`. ¿En qué situación
   **no** se lanzaría esa interrupción, aunque el botón siga pulsado?

### Ejercicios de lectura
- **5.1** 🟢 Abre `index.html` y busca la constante `KEY_MAP`. Localiza qué
  tecla del teclado corresponde a `Start` (mira el comentario justo encima
  de `KEY_MAP`, que explica qué significa cada número). Anota la tecla y el
  número de `bit` que le corresponde.
- **5.2** 🟢 Vuelve a `class MMU` y busca `_readIO(addr)`. Localiza el `case
  0x00`. ¿A qué método, de qué objeto, redirige la lectura de la dirección
  `0xFF00`?
- **5.3** 🔵 Busca el método `read()` de `class Joypad`. Cuenta cuántas
  variables distintas se combinan (con operadores como `&` o `|`) antes de
  hacer el `return`. Sin necesidad de entender la operación bit a bit exacta,
  ¿por qué crees que hace falta combinar varias cosas en vez de devolver
  directamente `this.buttonState`?

---

## 6. APU — el sonido

### Contexto (hardware real)
Es una tercera pieza que funciona en paralelo al procesador y a la pantalla:
la APU (*Audio Processing Unit*, "chip de sonido") genera continuamente el
sonido a partir de la configuración que el juego ha dejado en su memoria,
sin que el procesador tenga que "calcular" el sonido en cada instante. La
Game Boy mezcla **4 canales** en una sola señal de salida:

- **Canal 1**: onda cuadrada con variación de tono (un "pew-pew" típico).
- **Canal 2**: onda cuadrada simple.
- **Canal 3**: una forma de onda personalizada, guardada en memoria.
- **Canal 4**: ruido, para explosiones o percusión.

### Dónde mirar
- Busca el comentario justo antes de `class APU` (explica los 4 canales).
- Busca `APU_DUTY_TABLE`: cuatro patrones distintos de onda cuadrada.
- Busca `APU_NOISE_DIVISORS`.

### Preguntas de comprensión
1. 🟢 Busca `APU_DUTY_TABLE`. Copia la primera fila (12,5%) y la última fila
   (75%) tal como aparecen en el código. Cada una tiene 8 valores (`0` o
   `1`).
2. 🟢 Cuenta cuántos `1` hay en la fila del 12,5% y cuántos `1` hay en la
   fila del 75%. ¿El nombre de cada fila ("12,5%", "75%") coincide con la
   proporción de unos que has contado?
3. 🔵 Busca `APU_NOISE_DIVISORS`. Copia los 8 valores. Lee el comentario del
   principio de la sección ("Canal 4 - ruido pseudoaleatorio"). ¿Para qué
   tipo de sonido de un videojuego (explosión, disparo, melodía...) crees que
   se usaría este canal en vez de los canales de onda cuadrada?

### Ejercicios de lectura
- **6.1** 🟢 Busca `class GBEmulator` y, dentro, el método
  `stepHardware(cycles)`. Copia sus tres líneas. ¿Aparece `this.apu.step`
  en la misma lista que `this.ppu.step` y `this.timer.step`?
- **6.2** 🟢 Busca, dentro de `class MMU`, el método `_readIO(addr)`.
  Localiza la línea que empieza por `if (reg >= 0x10 && reg <= 0x3F)`. ¿A
  qué objeto redirige esa lectura?
- **6.3** 🔵 Busca `APU_IO_MASK`. Lee el comentario que tiene encima. Explica
  con tus palabras por qué algunos bits de algunos registros de sonido
  "siempre se leen como 1" en vez de devolver lo último que se escribió en
  ellos.

---

## 7. GBEmulator — la pieza que lo conecta todo

### Contexto (hardware real)
Ningún chip de la Game Boy funciona solo. El procesador, la pantalla, el
temporizador y el sonido tienen que avanzar **todos al mismo ritmo** para que
el juego funcione bien. En una placa base real, esto lo consigue un reloj
físico conectado a todos los chips a la vez. Aquí no existe ese reloj
compartido, así que `GBEmulator` hace ese trabajo a mano: después de cada
instrucción del procesador, le dice al resto de piezas "esto ha costado tantos
ciclos, avanza tú también esa misma cantidad".

### Dónde mirar
- Busca `stepHardware(cycles)`: reparte los mismos ciclos entre PPU, Timer y
  APU.
- Busca `_stepInstruction()`: ejecuta una instrucción del procesador y llama
  justo después a `stepHardware()`.
- Busca `runFrame()`: repite lo anterior hasta completar un frame de
  pantalla.
- Busca `loadROM(bytes)` (dentro de `class GBEmulator`, no de `class MMU`):
  qué se reinicia al cargar un cartucho nuevo.

### Preguntas de comprensión
1. 🟢 Busca `stepHardware(cycles)`. Copia sus tres líneas. Los tres
   componentes reciben el mismo parámetro `cycles`. ¿Qué crees que pasaría
   si, por error, uno de los tres recibiera solo la mitad de ciclos que los
   otros dos?
2. 🟢 Busca `runFrame()`. Localiza la constante que usa como límite del
   bucle (`GBEmulator.CYCLES_PER_FRAME`). Búscala también donde se define,
   cerca del principio de `class GBEmulator`, y anota su valor.
3. 🔵 Busca `_loop(now)`. Localiza la línea
   `elapsed = Math.min(elapsed, 200);` y el comentario que la acompaña.
   Con tus palabras: ¿qué problema evita ese límite si alguien deja la
   pestaña del navegador en segundo plano durante mucho tiempo?

### Ejercicios de lectura
- **7.1** 🟢 Busca `EMU_CORE_CONFIG.FRAME`. Localiza `CYCLES_PER_LINE`
  (número de ciclos por línea) y `TOTAL_LINES` (número total de líneas,
  suma de las visibles y las de VBlank). Multiplica ambos valores a mano.
  ¿Coincide tu resultado con el comentario que hay al lado de
  `CYCLES_PER_FRAME`?
- **7.2** 🟢 Busca el método `loadROM(bytes)` de `class GBEmulator`. Haz una
  lista de qué componentes se reinician (mira qué propiedades de `this.ppu`,
  `this.timer`, etc. se ponen a 0 o se llaman con `.reset()`).
- **7.3** 🔵 Busca `start()` y `pause()` en `class GBEmulator`. Localiza la
  línea `this.onAudioResume?.()` dentro de `start()`. El comentario que la
  acompaña dice que debe ocurrir "dentro de un gesto real del usuario (clic
  o soltar un archivo)". ¿Por qué crees que arrancar el sonido depende de
  que el usuario haya hecho clic justo antes, y no se puede activar solo con
  cargar la página?

---

## Colección final de preguntas y ejercicios

Todos son ejercicios de **búsqueda y lectura** sobre `emu-gb-core.js` (y, en
el 15, sobre `index.html`). No hace falta ejecutar nada.

### Bloque A — Localización rápida 🟢
Para cada apartado, indica **la clase y el método (o propiedad)** exactos
donde se resuelve lo que se pregunta. Basta con el nombre; no hace falta
copiar el código entero.

1. ¿Dónde se decide qué parte de la ROM está visible en la dirección
   `0x4000` cuando el cartucho usa el sistema de bancos MBC1?
2. ¿Dónde se calcula cuánto va a durar el dibujado de píxeles de la
   siguiente línea de pantalla?
3. ¿Dónde se define a qué dirección de memoria salta el procesador al
   recibir la interrupción del Joypad?
4. ¿Dónde se decide si el contador `TIMA` debe subir cada 1024, 16, 64 o
   256 ciclos?
5. ¿Dónde se transforma la tecla `Z` del teclado del ordenador en el botón
   `B` de la Game Boy?
6. ¿Dónde se juntan los tres pasos (`ppu.step`, `timer.step`, `apu.step`) en
   una sola llamada?

### Bloque B — Del hardware real al código 🟢🔵
7. 🟢 La Game Boy puede señalar 65.536 direcciones de memoria distintas.
   Busca `EMU_CORE_CONFIG.MEMORY.IO_SIZE`. ¿Por qué crees que ese número es
   mucho menor que 65.536, si se supone que representa "toda la zona de
   E/S"?
8. 🟢 Explica con tus propias palabras qué significa "E/S mapeada en
   memoria", citando **dos ejemplos distintos** de este archivo: uno
   relacionado con el Joypad y otro con el Timer o la PPU.
9. 🔵 ¿Por qué el procesador, la PPU, el Timer y la APU pueden avanzar de
   forma "independiente" entre sí y aun así mantenerse sincronizados? Cita
   el método concreto que hace posible esa sincronización (ya has trabajado
   con él en la sección 7).
10. 🔵 Un flag del procesador real (`Z`, `N`, `H`, `C`) ocupa, en el hardware
    original, un solo bit dentro de un único registro llamado `F`. Busca
    cómo se llaman las variables de este emulador que representan esos
    cuatro flags (pista: aparecen varias veces en `class CPU`, con nombres
    parecidos a `flagZ`). ¿Se guardan como bits de un único número, o como
    variables independientes?

### Bloque C — Lectura guiada de un fragmento concreto 🟢
Para cada apartado, localiza el fragmento indicado, cópialo tal cual, y
contesta la pregunta.

11. Busca la línea `this.directionState = 0x0F;`. Copia el comentario que la
    acompaña. Según ese comentario, ¿qué botón corresponde al bit número 3?
12. Busca `get lcdc()` dentro de `class PPU`. Copia la línea completa. ¿A qué
    posición del array `this.mmu.io` apunta?
13. Busca la constante `EMU_CORE_CONFIG.BOOT`. Copia el valor de `PC`. Ahora
    ve a `reset()` en `class CPU` y confirma que `this.PC` se inicializa con
    ese mismo valor.
14. Busca `hasROM()` en `class GBEmulator`. Copia la línea completa. Explica
    con tus palabras qué comprueba exactamente (fíjate en qué dos cosas
    combina con `&&`, aunque esté escrito de forma compacta).
15. Abre `index.html` y busca la línea `const emulator = new GBEmulator();`.
    ¿En qué archivo (`emu-gb-core.js` o `index.html`) está definida la
    clase `GBEmulator`, y en cuál se **usa** para crear el objeto? ¿Qué
    relación ves entre esto y la diferencia entre "definir una clase" y
    "crear un objeto a partir de ella"?

### Bloque D — Pensamiento de sistemas (para relacionar con tu ciclo) 🔵
16. Un técnico de sistemas en red (ASIR) a menudo tiene que averiguar cómo
    funciona un programa o servicio sin tener acceso a quien lo escribió.
    ¿Qué parte de este tour se ha parecido más a ese tipo de trabajo?
17. Un técnico de microinformática (SMR) diagnostica averías de hardware
    real razonando por partes: fuente de alimentación, placa base,
    periféricos... De las seis piezas de este emulador (MMU, CPU, PPU,
    Timer, Joypad, APU), ¿cuál se parece más a un "periférico" (como un
    teclado) y cuál se parece más a un "chip interno" que el usuario nunca
    toca directamente?
18. La MMU centraliza todo el acceso a memoria: ni la PPU, ni la APU, ni el
    Joypad dejan que el juego los lea u escriba directamente sin pasar por
    la MMU (repásalo: en `_readIO`/`_writeIO`, todo pasa por ahí). ¿Qué
    ventaja de organización o de mantenimiento tiene centralizar el acceso
    en un único punto, en vez de que cada pieza gestione su propio trozo de
    memoria por separado?
19. Todo el emulador reparte el trabajo en seis piezas con una tarea clara
    cada una, más una séptima pieza (`GBEmulator`) que solo las conecta.
    ¿Qué ventaja tiene, a la hora de **buscar un fallo en un programa**, que
    el código esté organizado así en vez de todo junto en un único bloque?
20. **Ejercicio de cierre.** Elige una de las seis piezas de hardware (MMU,
    CPU, PPU, Timer, Joypad o APU) y escribe un párrafo breve (5-8 líneas)
    explicándosela a un compañero que no ha hecho este tour. Incluye, como
    mínimo: (a) qué problema real de la Game Boy resuelve esa pieza, (b) el
    nombre de la clase y de al menos un método donde se ve en el código, y
    (c) una línea concreta del archivo que hayas copiado durante el tour
    como prueba de lo que explicas.
