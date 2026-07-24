# Recorrido simple: viendo "por dentro" una computadora real

Este documento acompaña al archivo `emu-gb-core.js`, un emulador de Game Boy
escrito en JavaScript. **No hace falta saber programar para aprovecharlo.**
La idea no es que escribas ni modifiques código, sino que *localices* piezas
concretas dentro de un programa real y comprobar que los conceptos que ves
en clase (bus de direcciones, memoria, E/S, interrupciones, reloj de
sistema...) no son abstracciones de pizarra: son literalmente así de
concretos incluso en un programa que corre en un navegador.

**Cómo trabajar este documento:**
- Abre `emu-gb-core.js` con cualquier editor de texto (Bloc de notas,
  VS Code, gedit... lo que tengas a mano).
- Usa **Ctrl+F / buscar** para localizar los términos que se indican en
  cada parada. No necesitas leer el código línea por línea ni entender la
  sintaxis de JavaScript — solo identificar *dónde vive cada cosa* y leer
  los comentarios que lo rodean (las líneas que empiezan por `//` o están
  entre `/* ... */`), que están escritos en un lenguaje bastante llano.
- Cada parada termina con una o dos **preguntas conceptuales**. No tienen
  una única respuesta "correcta" cerrada — son para razonar y discutir en
  clase, relacionando lo que ves en el archivo con hardware y sistemas
  reales que ya conoces o vas a conocer en el ciclo.

---

## Antes de empezar: cinco ideas que lo explican casi todo

Abre el archivo y lee el bloque de comentarios grande que hay justo al
principio (antes de que aparezca `const EMU_CORE_CONFIG`). Ahí se explican,
con analogías, las ideas de fondo que verás repetidas en cada componente:

1. **Fetch-decode-execute**: un procesador no "ejecuta un programa" de
   golpe — repite sin parar un ciclo diminuto: leer la siguiente
   instrucción, entender qué significa, hacerla, y pasar a la siguiente.
2. **Registros**: el procesador tiene un puñado de "cajones" internos
   ultrarrápidos donde guarda los números con los que está trabajando en
   ese instante — es memoria, pero no es RAM.
3. **E/S mapeada en memoria**: la pantalla, el teclado y el sonido pueden
   "fingir" ser direcciones de memoria normales, para que el procesador no
   necesite mecanismos distintos para hablar con cada periférico.
4. **Interrupciones**: en vez de que el procesador esté preguntando todo el
   rato "¿ha pasado algo?", el propio hardware le "da un toque en el hombro"
   cuando ocurre algo (se pulsa un botón, se acaba de dibujar la pantalla,
   etc.).
5. **Reloj y ciclos**: todo el sistema avanza al ritmo de un reloj que
   marca el compás millones de veces por segundo, y todos los componentes
   se mantienen sincronizados contando cuántos "tics" de ese reloj han
   pasado.

Con estas cinco ideas en la cabeza, cada parada de abajo es solo "¿dónde
vive esta idea en un componente concreto del sistema?"

---

## Parada 0 — La ficha técnica del sistema (`EMU_CORE_CONFIG`)

**Busca:** `const EMU_CORE_CONFIG`

Esto es lo más parecido a una hoja de especificaciones (un "datasheet") de
la Game Boy: la frecuencia de reloj (`CLOCK_HZ`), el tamaño de la pantalla,
y — lo más importante para el resto del recorrido — el objeto `MEMORY`,
que reparte los 64KB de direcciones disponibles en "zonas" con nombre (ROM,
memoria de vídeo, RAM de trabajo, etc.), igual que un plano de un edificio
reparte metros cuadrados en habitaciones.

**Preguntas:**
- En un ordenador o servidor real, ¿qué documentación o herramienta
  cumpliría un papel parecido al de esta tabla (es decir, "qué hay en cada
  rango de direcciones o recursos del sistema")? Piensa en herramientas de
  diagnóstico que hayas usado o vayas a usar (por ejemplo, mapas de
  memoria, particiones de disco, rangos de IP en una red).
- ¿Por qué crees que es útil que un sistema tenga sus recursos organizados
  en "zonas" claramente delimitadas en vez de un único bloque homogéneo?

---

## Parada 1 — MMU: el mapa de memoria (`class MMU`)

**Busca:** `class MMU`, y dentro de ella, `read8` y `write8`.

Esta clase es el "controlador de tráfico" de todo el sistema: cada vez que
el procesador quiere leer o escribir un dato, pasa por aquí primero. No
hace falta entender el código de `read8()`/`write8()` — basta con notar que
es una lista de comprobaciones tipo "¿la dirección cae en este rango? Pues
entonces ve a buscar el dato aquí." Es exactamente el mismo concepto que un
**enrutador o switch decidiendo por dónde sale un paquete** según su
dirección de destino, o que una tabla de particiones decidiendo qué
partición de disco corresponde a un sector concreto.

Busca también el método `_readIO()`. Ahí verás que ciertas direcciones no
van a la RAM en absoluto, sino que se redirigen a otras clases (el joypad,
el reloj, el sonido) — la E/S mapeada en memoria de la que hablábamos
arriba, en estado puro.

**Preguntas:**
- Si tuvieras que explicarle a alguien sin conocimientos técnicos qué hace
  esta clase, usando solo la analogía de un edificio con distintas
  habitaciones (o de un cartero repartiendo correo según el código
  postal), ¿cómo lo dirías?
- ¿Qué ventajas de seguridad o de organización tiene que **todo** el
  acceso a memoria pase obligatoriamente por un único punto centralizado
  (esta clase), en vez de que cada componente acceda directamente a la
  memoria por su cuenta? (Piensa en el concepto de "punto único de
  control" que también se aplica en redes y sistemas — cortafuegos,
  proxies, etc.)

---

## Parada 2 — CPU: el procesador (`class CPU`)

**Busca:** `class CPU`, y dentro, el método `step()`.

No hace falta entender ni una línea del código de `execute()` (ahí es
donde se decodifican las instrucciones, y sí que requiere manejar
hexadecimal y bits). Lo que sí merece la pena mirar:

- El principio de la clase, donde se declaran cosas como `this.A`,
  `this.B`, `this.SP`, `this.PC`. Son los "registros" — nombres que
  probablemente reconozcas de teoría de arquitectura de computadores
  (acumulador, puntero de pila, contador de programa).
- El método `step()` en sí: aunque el contenido sea código, fíjate en que
  es corto y se repite constantemente — es literalmente el bucle
  fetch-decode-execute de la idea 1, hecho realidad en 20-30 líneas.

**Preguntas:**
- El "contador de programa" (`PC`) guarda la dirección de la siguiente
  instrucción a ejecutar. Si un programa tiene un fallo y ese valor
  apunta a un sitio de memoria que no contiene código válido, ¿qué tipo de
  problema esperarías que causara eso en un sistema real (piensa en
  errores de sistema o "pantallazos" que hayas visto)?
- ¿Por qué crees que el procesador solo tiene unos pocos registros internos
  (en vez de, por ejemplo, poder trabajar directamente con toda la RAM del
  sistema)? ¿Qué relación tiene esto con la diferencia de velocidad entre
  la caché/registros de un procesador real y su memoria RAM?

---

## Parada 3 — PPU: cómo se genera la imagen (`class PPU`)

**Busca:** `class PPU`, y el comentario grande justo encima que empieza con
"Section 3".

Este componente convierte datos guardados en memoria en la imagen que ves
en pantalla, línea por línea, muchas veces por segundo — igual que hace
(a mucha más escala y velocidad) la tarjeta gráfica de un ordenador real.
Fíjate en la tabla de registros (`0xFF40 LCDC`, `0xFF44 LY`, etc.) que
aparece en los comentarios: son direcciones concretas de memoria que
controlan la pantalla, otro ejemplo de E/S mapeada en memoria.

**Preguntas:**
- La pantalla se "redibuja" muchas veces por segundo, línea por línea, en
  vez de mostrar toda la imagen de golpe en un único instante. ¿En qué se
  parece esto a cómo funcionaba (y en parte sigue funcionando, en el
  concepto de "tasa de refresco") un monitor real?
- El registro `LY` indica en todo momento qué línea de la pantalla se está
  dibujando ahora mismo. ¿Por qué crees que es útil que ese dato esté
  disponible para que otras partes del sistema lo puedan consultar en
  cualquier momento, en vez de ser un dato "oculto" solo para la propia
  pantalla?

---

## Parada 4 — El reloj del sistema (`class Timer`)

**Busca:** `class Timer`.

Es una clase corta — merece la pena leerla entera, aunque sea código. El
comentario justo antes de ella explica que el registro llamado `DIV` no es
más que "una parte visible" de un contador binario que nunca se detiene.
Cuando otro contador interno (`TIMA`) se desborda, se dispara una
interrupción — el "toque en el hombro" de la idea 4.

**Preguntas:**
- En un ordenador real, el reloj del sistema (el que usas para ver la hora,
  o el que marca los "tics" que usa el sistema operativo para repartir
  tiempo de CPU entre programas) también se basa en un contador de
  hardware. ¿Qué pasaría, en tu opinión, si ese contador se pudiera
  desincronizar o resetear sin control?
- ¿Se te ocurre algún ejemplo real de tu entorno (una alarma, un temporizador de
  cocina, un `cron` en Linux) que funcione con el mismo principio de "contar
  hasta un límite y entonces avisar", en vez de estar comprobando
  constantemente si ya ha pasado el tiempo?

---

## Parada 5 — Joypad: cómo entra la información del usuario (`class Joypad`)

**Busca:** `class Joypad`. Es la clase más corta y sencilla de todo el
archivo — léela entera sin miedo.

Aquí ves cómo hasta 8 botones distintos se comprimen en un único byte que
el procesador puede leer con una sola operación. Es el ejemplo más limpio
de E/S mapeada en memoria de todo el archivo, y por eso vale la pena
mirarlo aunque ya hayas visto la idea en la MMU.

**Preguntas:**
- Este dispositivo también genera una interrupción cuando se pulsa un
  botón (búscalo: `requestInterrupt`). Compáralo con cómo tu ordenador o
  móvil reacciona al instante cuando conectas un periférico USB o tocas la
  pantalla, sin que el sistema tenga que estar "preguntando" todo el rato
  si ha pasado algo. ¿Qué ventaja de eficiencia energética o de rendimiento
  tiene este modelo frente al de "preguntar constantemente" (esto último se
  llama *polling*, un término que probablemente veas en el ciclo)?
- ¿Por qué crees que tiene sentido reservar solo un bit por botón (en vez
  de, por ejemplo, un byte entero) para representar si está pulsado o no?

---

## Parada 6 — APU: cómo se genera el sonido (`class APU`)

**Busca:** `class APU`, y la tabla de canales en el comentario justo
encima ("Ch1", "Ch2", "Ch3", "Ch4").

No hace falta entender la matemática de generación de ondas. Lo importante
conceptualmente: hay **cuatro generadores de sonido independientes** que se
combinan ("se mezclan") en una sola señal final, y cada uno se controla
escribiendo valores en direcciones de memoria concretas (otra vez E/S
mapeada en memoria). Busca también la palabra `DAC` en los comentarios —
es un término (convertidor digital-analógico) que reaparece en cualquier
equipo de audio, tarjeta de sonido o interfaz de audio profesional real.

**Preguntas:**
- ¿Por qué crees que un sistema digital (que solo entiende ceros y unos)
  necesita un componente específico (el DAC) para poder producir sonido
  que salga por un altavoz, en vez de conectar el altavoz directamente al
  circuito digital?
- Aquí, cuatro fuentes de sonido distintas se combinan en una sola señal.
  ¿Se te ocurre algún otro sistema con el que hayas trabajado o vayas a
  trabajar donde varias señales o flujos de datos independientes se
  combinan en una sola salida (por ejemplo, en redes, en streaming de
  vídeo, o en una mesa de mezclas)?

---

## Parada 7 — GBEmulator: quién manda sobre todos los demás (`class GBEmulator`)

**Busca:** `class GBEmulator`, y dentro, los métodos `stepHardware()` y
`runFrame()`.

Esta clase no representa ningún chip físico real — es puramente la pieza de
"orquestación" que hace falta en software para mantener sincronizados al
procesador, la pantalla, el reloj y el sonido, algo que en el hardware real
ocurre gratis porque todos comparten literalmente el mismo cable de reloj.
Fíjate en que `stepHardware()` es muy corta: después de cada instrucción
del procesador, le dice a cada uno de los demás componentes "ha pasado
tanto tiempo, avanza tú también lo mismo."

**Preguntas:**
- Esta clase actúa como una especie de "coordinador" o "supervisor" de los
  demás componentes. ¿Qué parte de un sistema operativo real cumple un
  papel parecido, coordinando que la CPU, el disco, la red y la memoria
  trabajen de forma sincronizada? (Pista: piensa en el núcleo/kernel y el
  planificador de procesos.)
- Busca también el método `_loop()`. En los comentarios se explica que
  intenta mantener el ritmo real de fotogramas por segundo del hardware
  original, incluso si el navegador va más lento o más rápido de lo
  esperado. ¿Por qué es importante que un sistema pueda "adaptarse" al
  ritmo real en el que corre, en vez de asumir que siempre va a tener
  disponible exactamente la misma capacidad de proceso?

---

## Parada 8 — La capa de aplicación (`index.html`)

**Busca:** la etiqueta `<script>` dentro de `index.html`.

Aquí no hay ningún concepto nuevo de hardware — es la conexión entre el
"motor" (`emu-gb-core.js`) y las cosas reales del navegador: un lienzo
(`canvas`) donde se dibuja la imagen, una salida de audio, y los eventos de
teclado. Es exactamente el papel que juega un **controlador (driver)** en
un sistema operativo real: traduce entre un componente genérico y el
hardware/API concretos de la máquina en la que corre.

**Preguntas:**
- Si mañana quisieras adaptar este mismo "motor" (`emu-gb-core.js`) para
  que corriera, por ejemplo, dentro de una aplicación de escritorio en vez
  de un navegador, ¿qué archivo de los dos crees que habría que cambiar
  más, y por qué? ¿Qué relación tiene esto con la idea de "controladores"
  (drivers) que permiten que el mismo sistema operativo funcione en
  hardware distinto?

---

## Glosario rápido

- **Bus de direcciones**: el "camino" por el que el procesador especifica
  con qué dirección de memoria quiere hablar. Aquí son 16 bits → hasta 65.536
  direcciones distintas (0x0000 a 0xFFFF).
- **E/S mapeada en memoria**: cuando un dispositivo (pantalla, teclado,
  sonido...) se controla escribiendo o leyendo direcciones de memoria,
  igual que si fuera RAM normal, en vez de tener un mecanismo aparte.
- **Interrupción**: una señal que "interrumpe" al procesador para avisarle
  de que ha pasado algo importante, en vez de que el procesador tenga que
  preguntar constantemente (*polling*).
- **Registro**: una pequeña posición de almacenamiento dentro del propio
  procesador, mucho más rápida que la RAM pero también mucho más limitada
  en cantidad.
- **Reloj (clock)**: la señal que marca el ritmo al que avanza todo el
  sistema, contado en "ciclos" o "tics".
- **Controlador (driver)**: la pieza de software que traduce entre un
  componente genérico y el hardware o sistema concreto en el que corre.

---

## Para pensar en grupo (a modo de repaso final)

1. A lo largo de este recorrido has visto el mismo patrón repetirse una y
   otra vez: "un componente expone su estado en unas direcciones de memoria
   concretas, y otras partes del sistema leen o escriben ahí para
   comunicarse con él." Elige dos de los componentes vistos (por ejemplo,
   Joypad y APU) y explica ese patrón con tus propias palabras usando esos
   dos ejemplos.
2. Elige un componente del recorrido (MMU, CPU, PPU, Timer, Joypad, APU o
   GBEmulator) y explica, sin usar ni una palabra en inglés técnico si es
   posible, qué problema del mundo real resuelve — como si se lo
   explicaras a alguien que va a hacer soporte técnico o mantenimiento de
   sistemas y nunca ha programado.
3. De todo lo visto, ¿qué concepto crees que te va a resultar más útil
   reconocer el día que estés delante de un sistema real (mantenimiento de
   equipos, administración de un servidor, diagnóstico de una red)? ¿Por
   qué?
