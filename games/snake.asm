; ============================================================
; SNAKE for GB - RGBDS assembly
;
; Build (no logo in the header - see note below):
;   rgbasm  -o snake.o  snake.asm
;   rgblink -o snake.gb snake.o
;   rgbfix  -f hg -p 0xFF snake.gb
;
; -f hg fixes the header checksum (h) and global checksum (g) only.
; The 'l' flag (which writes the real logo) is deliberately
; left out, so the logo bytes stay zeroed. Most emulators run this
; fine, but real hardware and strict emulators that check the boot
; logo will refuse it - add 'l' back (i.e. use -v) if you need that.
;
; Controls: D-Pad to steer, START to restart after Game Over.
;
; Design notes:
;  - The snake is drawn using background tiles (not sprites),
;    which sidesteps the GB's 10-sprites-per-scanline limit.
;  - Movement is grid-based on a 20x18 tile playfield (the
;    whole visible screen).
;  - Food placement doesn't check for overlap with the snake
;    body - a nice follow-up improvement if you want one.
; ============================================================

; ---------------- Hardware registers ----------------
DEF rP1     EQU $FF00   ; Joypad
DEF rDIV    EQU $FF04   ; Divider register (used as RNG entropy)
DEF rLCDC   EQU $FF40   ; LCD control
DEF rLY     EQU $FF44   ; Current scanline
DEF rBGP    EQU $FF47   ; Background palette
DEF rNR52   EQU $FF26   ; Sound on/off

; ---------------- Game constants ----------------
DEF GRID_W          EQU 20      ; playfield width in tiles
DEF GRID_H          EQU 18      ; playfield height in tiles
DEF SNAKE_MAX_LEN   EQU 100     ; max snake length we allocate room for
DEF MOVE_INTERVAL   EQU 8       ; frames between snake moves (lower = faster)

DEF DIR_UP    EQU 0
DEF DIR_DOWN  EQU 1
DEF DIR_LEFT  EQU 2
DEF DIR_RIGHT EQU 3

DEF TILE_BLANK EQU 0
DEF TILE_BODY  EQU 1
DEF TILE_FOOD  EQU 2

DEF TILE_DATA_SIZE EQU 48   ; 3 tiles * 16 bytes each


; ============================================================
; Header - rgbfix will patch in the Nintendo logo & checksums
; ============================================================
SECTION "Header", ROM0[$100]
    jp EntryPoint
    ds $150 - @, 0


; ============================================================
; WRAM variables
; ============================================================
SECTION "Variables", WRAM0

wSnakeX:        ds SNAKE_MAX_LEN   ; x position of each body segment (0 = head)
wSnakeY:        ds SNAKE_MAX_LEN   ; y position of each body segment
wSnakeLength:   ds 1
wDirection:     ds 1
wFrameCounter:  ds 1
wGameOver:      ds 1

wFoodX:         ds 1
wFoodY:         ds 1
wRngSeed:       ds 1

wJoyState:      ds 1   ; packed input: bit7=Down bit6=Up bit5=Left bit4=Right
                        ;               bit3=Start bit2=Select bit1=B bit0=A

; scratch variables used inside MoveSnake
wNewX:          ds 1
wNewY:          ds 1
wWillEat:       ds 1
wCheckCount:    ds 1
wIndex:         ds 1
wTailIndex:     ds 1
wOldTailX:      ds 1
wOldTailY:      ds 1
wShiftIndex:    ds 1


; ============================================================
; Main program
; ============================================================
SECTION "Main", ROM0

EntryPoint:
    di
    call WaitVBlank
    xor a
    ld [rLCDC], a          ; LCD off (only safe to touch VRAM freely while off)

    ld a, %11100100
    ld [rBGP], a           ; standard 1:1 palette (0=white .. 3=black)

    xor a
    ld [rNR52], a          ; sound off, we don't use it

    call LoadTiles
    call InitGame

    ld a, %10010001        ; LCD on, BG on, tile data at $8000, map at $9800
    ld [rLCDC], a

MainLoop:
    call WaitVBlank
    call ReadInput
    call CheckInput

    ld a, [wGameOver]
    and a
    jr nz, .handleGameOver

    ld a, [wFrameCounter]
    inc a
    ld [wFrameCounter], a
    cp MOVE_INTERVAL
    jr nz, MainLoop
    xor a
    ld [wFrameCounter], a
    call MoveSnake
    jr MainLoop

.handleGameOver
    ld a, [wJoyState]
    bit 3, a            ; Start pressed?
    jr z, MainLoop
    call InitGame
    jr MainLoop


; ------------------------------------------------------------
; WaitVBlank - blocks until the start of the vertical blank
; ------------------------------------------------------------
WaitVBlank:
    ld a, [rLY]
    cp 144
    jr nz, WaitVBlank
    ret


; ------------------------------------------------------------
; ReadInput - reads both D-pad and buttons into wJoyState
; ------------------------------------------------------------
ReadInput:
    ld a, $20              ; select D-pad
    ld [rP1], a
    ld a, [rP1]            ; a few reads let the hardware settle
    ld a, [rP1]
    ld a, [rP1]
    ld a, [rP1]
    cpl                    ; active-low -> active-high
    and $0F
    swap a                 ; move dpad bits into upper nibble
    ld b, a

    ld a, $10              ; select buttons
    ld [rP1], a
    ld a, [rP1]
    ld a, [rP1]
    ld a, [rP1]
    ld a, [rP1]
    cpl
    and $0F
    or b
    ld [wJoyState], a

    ld a, $30              ; deselect both (good practice)
    ld [rP1], a
    ret


; ------------------------------------------------------------
; CheckInput - updates wDirection from wJoyState.
; Reversing directly into yourself is disallowed.
; ------------------------------------------------------------
CheckInput:
    ld a, [wJoyState]
    bit 6, a               ; Up
    jr z, .notUp
    ld a, [wDirection]
    cp DIR_DOWN
    jr z, .notUp
    ld a, DIR_UP
    ld [wDirection], a
    ret
.notUp
    ld a, [wJoyState]
    bit 7, a               ; Down
    jr z, .notDown
    ld a, [wDirection]
    cp DIR_UP
    jr z, .notDown
    ld a, DIR_DOWN
    ld [wDirection], a
    ret
.notDown
    ld a, [wJoyState]
    bit 5, a               ; Left
    jr z, .notLeft
    ld a, [wDirection]
    cp DIR_RIGHT
    jr z, .notLeft
    ld a, DIR_LEFT
    ld [wDirection], a
    ret
.notLeft
    ld a, [wJoyState]
    bit 4, a               ; Right
    jr z, .notRight
    ld a, [wDirection]
    cp DIR_LEFT
    jr z, .notRight
    ld a, DIR_RIGHT
    ld [wDirection], a
.notRight
    ret


; ------------------------------------------------------------
; InitGame - (re)sets game state and draws the starting board
; ------------------------------------------------------------
InitGame:
    xor a
    ld [wGameOver], a
    ld [wFrameCounter], a
    ld a, DIR_RIGHT
    ld [wDirection], a
    ld a, 3
    ld [wSnakeLength], a

    ld a, 10
    ld [wSnakeX+0], a
    ld a, 9
    ld [wSnakeY+0], a
    ld a, 9
    ld [wSnakeX+1], a
    ld a, 9
    ld [wSnakeY+1], a
    ld a, 8
    ld [wSnakeX+2], a
    ld a, 9
    ld [wSnakeY+2], a

    call ClearBackground

    ld b, 10
    ld c, 9
    ld a, TILE_BODY
    call SetTile
    ld b, 9
    ld c, 9
    ld a, TILE_BODY
    call SetTile
    ld b, 8
    ld c, 9
    ld a, TILE_BODY
    call SetTile

    call PlaceFood
    ret


; ------------------------------------------------------------
; MoveSnake - advances the snake by one grid cell
; ------------------------------------------------------------
MoveSnake:
    ld a, [wSnakeX+0]
    ld b, a
    ld a, [wSnakeY+0]
    ld c, a

    ld a, [wDirection]
    cp DIR_UP
    jr z, .up
    cp DIR_DOWN
    jr z, .down
    cp DIR_LEFT
    jr z, .left
    inc b                  ; RIGHT
    jr .store
.up
    dec c
    jr .store
.down
    inc c
    jr .store
.left
    dec b
.store
    ld a, b
    ld [wNewX], a
    ld a, c
    ld [wNewY], a

    ; --- wall collision ---
    ld a, [wNewX]
    cp GRID_W
    jp nc, .die
    ld a, [wNewY]
    cp GRID_H
    jp nc, .die

    ; --- food collision? ---
    ld a, [wFoodX]
    ld b, a
    ld a, [wNewX]
    cp b
    jr nz, .noEat
    ld a, [wFoodY]
    ld b, a
    ld a, [wNewY]
    cp b
    jr nz, .noEat
    ld a, 1
    ld [wWillEat], a
    jr .eatDone
.noEat
    xor a
    ld [wWillEat], a
.eatDone

    ; --- self collision ---
    ld a, [wSnakeLength]
    ld [wCheckCount], a
    ld a, [wWillEat]
    and a
    jr nz, .doCheck
    ld a, [wCheckCount]
    dec a
    ld [wCheckCount], a
.doCheck
    ld a, [wCheckCount]
    and a
    jr z, .noSelfCollision
    xor a
    ld [wIndex], a
.selfLoop
    ld a, [wIndex]
    ld b, a
    ld a, [wCheckCount]
    cp b
    jr z, .noSelfCollision

    ld a, [wIndex]
    ld l, a
    ld h, 0
    ld de, wSnakeX
    add hl, de
    ld a, [hl]
    ld b, a
    ld a, [wNewX]
    cp b
    jr nz, .notMatch

    ld a, [wIndex]
    ld l, a
    ld h, 0
    ld de, wSnakeY
    add hl, de
    ld a, [hl]
    ld b, a
    ld a, [wNewY]
    cp b
    jr nz, .notMatch

    jp .die                ; both x and y matched -> collision

.notMatch
    ld a, [wIndex]
    inc a
    ld [wIndex], a
    jr .selfLoop

.noSelfCollision
    ; --- growth / tail bookkeeping ---
    ld a, [wWillEat]
    and a
    jr z, .noGrow

    ld a, [wSnakeLength]
    cp SNAKE_MAX_LEN
    jr nc, .doShift        ; already at cap, don't grow further
    inc a
    ld [wSnakeLength], a
    jr .doShift

.noGrow
    ld a, [wSnakeLength]
    dec a
    ld [wTailIndex], a
    ld l, a
    ld h, 0
    ld de, wSnakeX
    add hl, de
    ld a, [hl]
    ld [wOldTailX], a
    ld a, [wTailIndex]
    ld l, a
    ld h, 0
    ld de, wSnakeY
    add hl, de
    ld a, [hl]
    ld [wOldTailY], a

.doShift
    ld a, [wSnakeLength]
    dec a
    ld [wShiftIndex], a
.shiftLoop
    ld a, [wShiftIndex]
    and a
    jr z, .shiftDone

    ld a, [wShiftIndex]
    ld l, a
    ld h, 0
    ld de, wSnakeX
    add hl, de
    push hl
    ld a, [wShiftIndex]
    dec a
    ld l, a
    ld h, 0
    ld de, wSnakeX
    add hl, de
    ld a, [hl]
    pop hl
    ld [hl], a

    ld a, [wShiftIndex]
    ld l, a
    ld h, 0
    ld de, wSnakeY
    add hl, de
    push hl
    ld a, [wShiftIndex]
    dec a
    ld l, a
    ld h, 0
    ld de, wSnakeY
    add hl, de
    ld a, [hl]
    pop hl
    ld [hl], a

    ld a, [wShiftIndex]
    dec a
    ld [wShiftIndex], a
    jr .shiftLoop
.shiftDone

    ld a, [wNewX]
    ld [wSnakeX+0], a
    ld a, [wNewY]
    ld [wSnakeY+0], a

    ld a, [wNewX]
    ld b, a
    ld a, [wNewY]
    ld c, a
    ld a, TILE_BODY
    call SetTile

    ld a, [wWillEat]
    and a
    jr nz, .ateFood
    ld a, [wOldTailX]
    ld b, a
    ld a, [wOldTailY]
    ld c, a
    ld a, TILE_BLANK
    call SetTile
    ret
.ateFood
    call PlaceFood
    ret

.die
    ld a, 1
    ld [wGameOver], a
    ret


; ------------------------------------------------------------
; PlaceFood - picks a new random spot and draws the food tile
; ------------------------------------------------------------
PlaceFood:
    call Random            ; b = x (0-19), c = y (0-17)
    ld a, b
    ld [wFoodX], a
    ld a, c
    ld [wFoodY], a
    ld a, TILE_FOOD
    call SetTile
    ret


; ------------------------------------------------------------
; Random - simple pseudo-random generator using rDIV + a
; running seed. Returns b = x (0-19), c = y (0-17).
; ------------------------------------------------------------
Random:
    ld a, [rDIV]
    ld hl, wRngSeed
    add a, [hl]
    ld [hl], a
    and $1F                ; 0-31
    cp GRID_W
    jr c, .xOk
    sub GRID_W
.xOk
    ld b, a

    ld a, [rDIV]
    ld hl, wRngSeed
    add a, [hl]
    add a, b
    ld [hl], a
    and $1F
    cp GRID_H
    jr c, .yOk
    sub GRID_H
.yOk
    ld c, a
    ret


; ------------------------------------------------------------
; SetTile - writes tile id `a` at grid position (b=x, c=y)
; into the background map at $9800.
; ------------------------------------------------------------
SetTile:
    push af
    ld h, 0
    ld l, c
    add hl, hl              ; y*2
    add hl, hl              ; y*4
    add hl, hl              ; y*8
    add hl, hl              ; y*16
    add hl, hl              ; y*32
    ld d, 0
    ld e, b
    add hl, de              ; + x
    ld de, $9800
    add hl, de               ; + base map address
    pop af
    ld [hl], a
    ret


; ------------------------------------------------------------
; ClearBackground - fills the whole 32x32 tilemap with tile 0
; ------------------------------------------------------------
ClearBackground:
    ld hl, $9800
    ld bc, 1024
.clearLoop
    xor a
    ld [hl+], a
    dec bc
    ld a, b
    or c
    jr nz, .clearLoop
    ret


; ------------------------------------------------------------
; LoadTiles - copies tile pattern data into VRAM at $8000
; ------------------------------------------------------------
LoadTiles:
    ld hl, $8000
    ld de, TileData
    ld bc, TILE_DATA_SIZE
.copyLoop
    ld a, [de]
    ld [hl+], a
    inc de
    dec bc
    ld a, b
    or c
    jr nz, .copyLoop
    ret


; ------------------------------------------------------------
; Tile graphics (2bpp, 16 bytes each)
; ------------------------------------------------------------
TileData:
    ; Tile 0: blank
    db $00,$00, $00,$00, $00,$00, $00,$00
    db $00,$00, $00,$00, $00,$00, $00,$00

    ; Tile 1: solid body block (palette color 3, black)
    db $FF,$FF, $FF,$FF, $FF,$FF, $FF,$FF
    db $FF,$FF, $FF,$FF, $FF,$FF, $FF,$FF

    ; Tile 2: food, a small diamond (palette color 1, light gray)
    db $18,$00, $3C,$00, $7E,$00, $FF,$00
    db $FF,$00, $7E,$00, $3C,$00, $18,$00
