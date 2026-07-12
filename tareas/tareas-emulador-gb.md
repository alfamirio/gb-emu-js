# Tareas prácticas: explorando una computadora real con el emulador de Game Boy

**Dirigido a:** estudiantes de FP de Informática (DAM / DAW / ASIR / SMR)
**Material necesario:** el emulador (`index.html` + JS), un ROM homebrew legal (ver README, sección *Further reading*), navegador moderno.
**Cómo usarlo:** cada bloque corresponde aprox. a una sesión de 1-2 horas. Dentro de cada bloque hay tareas de **observación** (mirar y entender), **manipulación** (cambiar algo y ver el efecto) y **entrega** (documentar lo aprendido).

---

## Bloque 0 — Puesta en marcha

- [ ] Abre `index.html` en el navegador. Arrastra un ROM homebrew legal (recomendado: alguno pequeño de los enlazados en el README).
- [ ] Localiza en la interfaz: panel de traza de CPU, mapa de memoria, visualizador de bancos MBC, panel PPU/CPU.
- [ ] Sin tocar nada más, deja correr el juego 30 segundos. Anota: ¿qué ves en pantalla? ¿qué controles responden?

**Entrega:** captura de pantalla + 3 líneas describiendo qué partes de la interfaz identificas y para qué crees que sirve cada una.

---

## Bloque 1 — El CPU: qué es "ejecutar una instrucción"

Objetivo: entender que un programa en ejecución es solo "leer byte → decodificar → cambiar estado → avanzar PC", repetido millones de veces por segundo.

- [ ] Pausa el emulador. Activa el panel de traza de ejecución paso a paso.
- [ ] Ejecuta 10 instrucciones una a una. Para cada una, anota en una tabla: dirección (PC), instrucción decodificada, qué registro(s) cambia, qué flags afecta.
- [ ] Busca en el código fuente la clase `CPU` y localiza la función `disassembleBytes`. Explica con tus palabras qué hace (no hace falta entender cada línea, sí el propósito).
- [ ] Localiza una instrucción de salto condicional (`JP`, `JR`, `CALL` con condición) en la traza. Explica qué papel juegan los flags `Z N H C` en si el salto se produce o no.

**Entrega:** tabla de las 10 instrucciones + explicación del salto condicional (máx. media página).

**Pregunta de reflexión:** si el CPU solo sabe "leer la siguiente dirección y ejecutar lo que hay ahí", ¿cómo sabe el ordenador *cuándo parar*? ¿Alguna vez para de verdad?

---

## Bloque 2 — Memoria: todo vive en el mismo mapa

Objetivo: entender que RAM, ROM y hardware comparten un único espacio de direcciones de 16 bits.

- [ ] Abre el mapa de memoria interactivo (`0x0000`–`0xFFFF`). Identifica visualmente dónde empieza y termina cada región (ROM banco 0, ROM banco N, VRAM, RAM de cartucho, WRAM, OAM, I/O, HRAM).
- [ ] Copia la tabla de memoria del `README.md` y complétala con una columna extra: "¿qué pasa si escribo aquí mientras el juego corre?" (una frase por región, con tus propias palabras).
- [ ] Localiza en vivo el valor del registro `LCDC` (`0xFF40`) en el inspector de memoria. Cambia manualmente un bit (si la interfaz lo permite) y observa el efecto en pantalla.
- [ ] Explica por qué escribir en `0xFF00` (registro del joypad) **no** es lo mismo que escribir en una celda de RAM normal, aunque desde el punto de vista de la CPU sea "la misma operación" (un `LD` a una dirección).

**Entrega:** tabla completada + explicación del punto anterior (5-8 líneas).

---

## Bloque 3 — Vídeo: de bytes a píxeles

Objetivo: entender que una imagen en pantalla es el resultado de interpretar datos crudos, no algo "especial".

- [ ] Con el juego pausado, abre el visualizador de VRAM/tiles. Localiza un tile concreto y dibuja a mano (en papel o Excel) su patrón 8×8 a partir de los bytes que ves.
- [ ] Explica la diferencia entre **tile** (el dibujo de 8×8) y **tilemap** (la rejilla 32×32 que dice qué tile va en cada casilla). ¿Por qué separar estos dos conceptos ahorra memoria frente a guardar la pantalla entera pixel a pixel?
- [ ] Localiza `SCX`/`SCY` (scroll) y `WX`/`WY` (ventana). Cambia sus valores si la interfaz lo permite y describe el efecto.
- [ ] Investiga (código o README) cuántas líneas tiene un frame completo y cuántas son visibles. ¿Qué pasa durante las líneas no visibles (V-Blank)? ¿Por qué es un buen momento para que el juego actualice cosas en memoria?

**Entrega:** dibujo del tile + respuestas a las 3 preguntas.

---

## Bloque 4 — Cartuchos con truco: bank-switching (MBC)

Objetivo: entender cómo un cartucho "engaña" a una CPU de 16 bits para ofrecerle más memoria de la que puede direccionar de golpe.

- [ ] Usa un ROM que use MBC1 o MBC3 (ver tabla del README). Abre el visualizador de bancos.
- [ ] Observa cómo cambian los bancos activos mientras el juego progresa (cambio de nivel, de mapa, etc.). Anota al menos 2 momentos en los que veas un cambio de banco y qué estaba pasando en el juego en ese instante.
- [ ] Con la tabla "MBC reference" del README delante, responde: si la CPU solo puede direccionar `0x0000`–`0xFFFF` (64 KB), ¿cómo puede un juego de MBC5 tener hasta 8 MB de ROM? Explica la idea de "ventana fija + ventana intercambiable".
- [ ] (Ampliación) Busca en el código el manejo de escrituras a direcciones de control del mapper dentro de la clase `MMU`. ¿Qué ocurre cuando el juego escribe en esas direcciones? (no hace falta leer todo el código, con localizar el bloque y describir su función basta).

**Entrega:** las 2 observaciones + la explicación de la ventana fija/intercambiable (máx. media página).

---

## Bloque 5 — Interrupciones: cuando el CPU se interrumpe a sí mismo

Objetivo: entender el concepto de interrupción sin necesidad de hablar de sistemas operativos todavía.

- [ ] Localiza en el panel de debug los registros `IE` (`0xFFFF`), `IF` (`0xFF0F`) y el flag interno `IME`.
- [ ] Explica con tus palabras por qué se necesitan *dos* registros (`IE` e `IF`) y no basta con uno solo.
- [ ] Provoca (jugando) al menos una interrupción de Joypad y observa en la traza qué ocurre en el CPU justo después: ¿a qué dirección salta? ¿qué pasa con `IME`?
- [ ] Investiga qué hace `EI` según el README (efecto retardado a la siguiente instrucción). ¿Por qué crees que el hardware real se diseñó así en vez de activar las interrupciones al instante?

**Entrega:** respuestas a las 4 preguntas.

---

## Bloque 6 — Cierre: reconstruir el ciclo completo

Objetivo: unir todas las piezas.

- [ ] En un único diagrama (a mano o con cualquier herramienta), dibuja cómo se relacionan CPU, MMU, PPU, Timer, APU y Joypad alrededor del bus de memoria compartido. Indica quién "manda" (quién marca el ritmo del reloj).
- [ ] Escribe un texto de media página explicando, con tus propias palabras y sin copiar el README, **qué es un ordenador** usando lo aprendido: un reloj que marca el ritmo, un CPU que lee y ejecuta instrucciones de una memoria compartida por direcciones, y periféricos que ese CPU controla escribiendo en direcciones concretas de esa misma memoria.
- [ ] Pregunta abierta para debate en clase: ¿qué tiene de diferente (y qué tiene en común) un PC moderno con esta Game Boy de 1989, más allá de la escala?

**Entrega:** diagrama + texto de cierre.

---

## Nota legal

Usa únicamente ROMs homebrew de licencia libre o dominio público (ver enlaces de itch.io en el `README.md` del proyecto). No se debe usar ni distribuir ROMs comerciales.
