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
;  - The snake body and the food are now drawn using OAM sprites
;    (objects) instead of background tiles. The background stays
;    blank (apart from the HUD row); every frame we rewrite the
;    sprite table from the wSnakeX/wSnakeY/wFoodX/wFoodY state.
;  - Only up to 7 sprites are ever in use (food + up to
;    SNAKE_MAX_LEN body segments), so we stay far under both the
;    10-sprites-per-scanline and 40-sprites-total hardware limits.
;  - The top background tile row is reserved as a HUD bar showing
;    a food-icon + score and a body-icon + elapsed time (seconds),
;    drawn with a small built-in digit font. The playfield below
;    it is 20x17 tiles.
;  - The snake length is capped at SNAKE_MAX_LEN (6): once the
;    snake reaches that length, eating food no longer grows it,
;    it just keeps moving, a new food spawns, and the score still
;    goes up.
;  - Food placement doesn't check for overlap with the snake
;    body - a nice follow-up improvement if you want one.
; ============================================================

; ---------------- Hardware registers ----------------
DEF rP1     EQU $FF00   ; Joypad
DEF rDIV    EQU $FF04   ; Divider register (used as RNG entropy)
DEF rLCDC   EQU $FF40   ; LCD control
DEF rLY     EQU $FF44   ; Current scanline
DEF rBGP    EQU $FF47   ; Background palette
DEF rOBP0   EQU $FF48   ; Object palette 0

; Sound channel 1 (square with sweep) - used for the "eat" blip
DEF rNR10   EQU $FF10
DEF rNR11   EQU $FF11
DEF rNR12   EQU $FF12
DEF rNR13   EQU $FF13
DEF rNR14   EQU $FF14

; Sound channel 2 (square, no sweep) - used for the background melody
DEF rNR21   EQU $FF16
DEF rNR22   EQU $FF17
DEF rNR23   EQU $FF18
DEF rNR24   EQU $FF19

; Sound channel 4 (noise) - used for the "game over" thud
DEF rNR41   EQU $FF20
DEF rNR42   EQU $FF21
DEF rNR43   EQU $FF22
DEF rNR44   EQU $FF23

; Sound master control
DEF rNR50   EQU $FF24   ; master volume (L/R)
DEF rNR51   EQU $FF25   ; channel L/R panning
DEF rNR52   EQU $FF26   ; sound on/off + channel status

; ---------------- OAM (sprite attribute table) ----------------
DEF OAM_BASE   EQU $FE00   ; start of OAM
DEF OAM_COUNT  EQU 40      ; total hardware sprites

; ---------------- Game constants ----------------
DEF GRID_W          EQU 20      ; playfield width in tiles
DEF GRID_H          EQU 17      ; playfield height in tiles (row 0 is the HUD bar)
DEF SNAKE_MAX_LEN   EQU 6       ; max snake length (also caps sprite usage)
DEF MOVE_INTERVAL   EQU 8       ; frames between snake moves (lower = faster)
DEF SECOND_FRAMES   EQU 60      ; ~frames per second, for the HUD timer

DEF DIR_UP    EQU 0
DEF DIR_DOWN  EQU 1
DEF DIR_LEFT  EQU 2
DEF DIR_RIGHT EQU 3

DEF TILE_BLANK EQU 0
DEF TILE_BODY  EQU 1
DEF TILE_FOOD  EQU 2
DEF DIGIT_TILE_BASE EQU 3   ; tiles 3-12 are digits '0'-'9'

DEF TILE_DATA_SIZE EQU 208  ; 3 icon tiles + 10 digit tiles, 16 bytes each

; Sprite Y is offset by one extra tile row (8px) versus the raw grid
; row, because screen tile row 0 is reserved for the HUD bar.
DEF SPRITE_Y_OFFSET EQU 24  ; = (1 HUD row + 1 OAM row-16 offset) * 8

; Food lives in OAM entry 0 ($FE00-$FE03). Snake segment i lives in
; OAM entry (i+1), i.e. at OAM_BASE + 4 + i*4.
DEF OAM_FOOD_ADDR   EQU OAM_BASE
DEF OAM_SNAKE_BASE  EQU OAM_BASE + 4

; ---------------- Music ----------------
; Square-channel period values (11-bit) for the notes used by the
; background melody: period = 2048 - 131072/freq.
DEF NOTE_REST EQU 0
DEF NOTE_C4   EQU 1547
DEF NOTE_D4   EQU 1602
DEF NOTE_E4   EQU 1650
DEF NOTE_F4   EQU 1673
DEF NOTE_G4   EQU 1714
DEF NOTE_A4   EQU 1750
DEF NOTE_B4   EQU 1783
DEF NOTE_C5   EQU 1798
DEF NOTE_D5   EQU 1825
DEF NOTE_E5   EQU 1849
DEF NOTE_F5   EQU 1860
DEF NOTE_G5   EQU 1881
DEF NOTE_A5   EQU 1899

DEF NOTE_FRAMES EQU 12   ; frames each melody note is held for
DEF MUSIC_LEN   EQU 16   ; number of notes in MusicTune


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

wScore:         ds 2   ; 16-bit score, little endian, +10 per food eaten
wTime:          ds 2   ; 16-bit elapsed seconds, little endian
wTimeFrames:    ds 1   ; counts frames up to SECOND_FRAMES to tick wTime

wJoyState:      ds 1   ; packed input: bit7=Down bit6=Up bit5=Left bit4=Right
                        ;               bit3=Start bit2=Select bit1=B bit0=A

; scratch variables used inside MoveSnake
wNewX:          ds 1
wNewY:          ds 1
wWillEat:       ds 1
wCheckCount:    ds 1
wIndex:         ds 1
wShiftIndex:    ds 1

; scratch variable used inside UpdateOAM
wOamIndex:      ds 1

; scratch variables used inside Bin16ToDec3 / UpdateHUD
wDigH:          ds 1
wDigT:          ds 1
wDigO:          ds 1

; music player state
wMusicIndex:    ds 1   ; current note index into MusicTune
wMusicTimer:    ds 1   ; frames left before advancing to the next note


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
    ld [rOBP0], a          ; same palette for sprites (color 0 is transparent)

    ld a, %10000000
    ld [rNR52], a          ; turn the APU on (must happen before touching NRxx)
    ld a, %01110111
    ld [rNR50], a          ; max master volume, both L and R
    ld a, %11111111
    ld [rNR51], a          ; route all 4 channels to both L and R
    ld a, %10000000
    ld [rNR21], a          ; channel 2 (melody): 50% duty
    xor a
    ld [wMusicIndex], a
    ld [wMusicTimer], a

    call LoadTiles
    call ClearOAM          ; hide all 40 hardware sprites before we use any
    call InitGame

    ld a, %10010011        ; LCD on, BG on, OBJ on, tile data at $8000, map at $9800
    ld [rLCDC], a

MainLoop:
    call WaitVBlank
    call UpdateOAM         ; push current snake/food positions out to sprites
    call UpdateHUD         ; redraw the score/time bar
    call MusicUpdate       ; advance the background melody
    call ReadInput
    call CheckInput

    ld a, [wGameOver]
    and a
    jr nz, .handleGameOver

    ; --- tick the elapsed-time counter (frozen once game over) ---
    ld a, [wTimeFrames]
    inc a
    ld [wTimeFrames], a
    cp SECOND_FRAMES
    jr nz, .noSecondTick
    xor a
    ld [wTimeFrames], a
    ld a, [wTime]
    add a, 1
    ld [wTime], a
    jr nc, .noSecondTick
    ld a, [wTime+1]
    inc a
    ld [wTime+1], a
.noSecondTick

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
    ld [wTimeFrames], a
    ld [wScore], a
    ld [wScore+1], a
    ld [wTime], a
    ld [wTime+1], a
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

    call ClearBackground   ; background stays blank; snake/food are sprites
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
    ; --- growth (capped at SNAKE_MAX_LEN) ---
    ld a, [wWillEat]
    and a
    jr z, .doShift

    ld a, [wSnakeLength]
    cp SNAKE_MAX_LEN
    jr nc, .doShift        ; already at cap, don't grow further
    inc a
    ld [wSnakeLength], a

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

    ; sprites are redrawn wholesale by UpdateOAM every frame, so there's
    ; no per-tile drawing/clearing to do here any more.
    ld a, [wWillEat]
    and a
    jr z, .noEatEnd

    ; +10 score for eating, even once the snake is at its length cap
    ld a, [wScore]
    add a, 10
    ld [wScore], a
    jr nc, .noScoreCarry
    ld a, [wScore+1]
    inc a
    ld [wScore+1], a
.noScoreCarry
    call PlaySfxEat
    call PlaceFood
.noEatEnd
    ret

.die
    ld a, 1
    ld [wGameOver], a
    call PlaySfxGameOver
    ret


; ------------------------------------------------------------
; PlaceFood - picks a new random spot for the food
; (the sprite showing it is drawn by UpdateOAM)
; ------------------------------------------------------------
PlaceFood:
    call Random            ; b = x (0-19), c = y (0-17)
    ld a, b
    ld [wFoodX], a
    ld a, c
    ld [wFoodY], a
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
; MusicUpdate - advances the background melody by one frame,
; retriggering channel 2 with the next note once the current
; note's hold time (NOTE_FRAMES) runs out. A period of NOTE_REST
; (0) is a silent beat rather than a note.
; ------------------------------------------------------------
MusicUpdate:
    ld a, [wMusicTimer]
    and a
    jr z, .nextNote
    dec a
    ld [wMusicTimer], a
    ret

.nextNote
    ld a, NOTE_FRAMES
    ld [wMusicTimer], a

    ; hl = MusicTune + wMusicIndex*2 (each entry is a 16-bit period)
    ld a, [wMusicIndex]
    ld l, a
    ld h, 0
    add hl, hl
    ld de, MusicTune
    add hl, de

    ld a, [hl+]
    ld e, a                ; period low byte
    ld a, [hl]
    ld d, a                ; period high byte

    ld a, d
    or e
    jr z, .rest

    ld a, $80              ; volume 8, no envelope sweep -> constant tone
    ld [rNR22], a
    ld a, e
    ld [rNR23], a
    ld a, d
    and $07
    or %10000000           ; trigger
    ld [rNR24], a
    jr .advance

.rest
    xor a
    ld [rNR22], a          ; volume 0 -> silent
    ld a, %10000000
    ld [rNR24], a          ; trigger (retriggers at volume 0, i.e. silence)

.advance
    ld a, [wMusicIndex]
    inc a
    cp MUSIC_LEN
    jr nz, .noWrap
    xor a
.noWrap
    ld [wMusicIndex], a
    ret


; ------------------------------------------------------------
; PlaySfxEat - short rising blip on channel 1 when food is eaten.
; ------------------------------------------------------------
PlaySfxEat:
    ld a, %00100011        ; sweep period 2, direction=up, shift 3
    ld [rNR10], a
    ld a, %10110000        ; duty 50%, length data 48 (short)
    ld [rNR11], a
    ld a, %11110010        ; initial volume 15, decrease, pace 2
    ld [rNR12], a
    ld a, LOW(NOTE_C5)
    ld [rNR13], a
    ld a, HIGH(NOTE_C5)
    and $07
    or %11000000           ; trigger + length enable
    ld [rNR14], a
    ret


; ------------------------------------------------------------
; PlaySfxGameOver - short decaying noise burst on channel 4,
; triggered once when the snake dies.
; ------------------------------------------------------------
PlaySfxGameOver:
    ld a, 32
    ld [rNR41], a          ; length data (moderate length)
    ld a, %11110100        ; initial volume 15, decrease, pace 4
    ld [rNR42], a
    ld a, %00100011        ; mid-pitched noise
    ld [rNR43], a
    ld a, %11000000        ; trigger + length enable
    ld [rNR44], a
    ret


; ------------------------------------------------------------
; ClearOAM - hides all 40 hardware sprites by zeroing OAM.
; A Y coordinate of 0 places a sprite entirely off the top of
; the screen, which is the standard way to hide unused sprites.
; ------------------------------------------------------------
ClearOAM:
    ld hl, OAM_BASE
    ld bc, OAM_COUNT * 4
    xor a
.clearLoop
    ld [hl+], a
    dec bc
    ld a, b
    or c
    jr nz, .clearLoop
    ret


; ------------------------------------------------------------
; UpdateOAM - writes the food and snake-segment sprites into
; OAM from the current game state (wFoodX/Y, wSnakeX/Y[]).
; Segments beyond the current snake length are hidden (Y=0),
; which also cleans up leftover sprites from a previous, longer
; snake after a restart.
; ------------------------------------------------------------
UpdateOAM:
    ; ---- food -> OAM entry 0 ----
    ld a, [wFoodY]
    add a, a
    add a, a
    add a, a
    add a, SPRITE_Y_OFFSET
    ld [OAM_FOOD_ADDR + 0], a      ; Y
    ld a, [wFoodX]
    add a, a
    add a, a
    add a, a
    add a, 8
    ld [OAM_FOOD_ADDR + 1], a      ; X
    ld a, TILE_FOOD
    ld [OAM_FOOD_ADDR + 2], a      ; tile
    xor a
    ld [OAM_FOOD_ADDR + 3], a      ; attributes

    ; ---- active snake segments -> OAM entries 1..SNAKE_MAX_LEN ----
    xor a
    ld [wOamIndex], a
.activeLoop
    ld a, [wOamIndex]
    ld b, a
    ld a, [wSnakeLength]
    cp b
    jr z, .hideRest

    ; hl = OAM_SNAKE_BASE + index*4
    ld a, b
    add a, a
    add a, a
    ld l, a
    ld h, 0
    ld de, OAM_SNAKE_BASE
    add hl, de

    ; Y = wSnakeY[index]*8 + 16
    push hl
    ld a, [wOamIndex]
    ld l, a
    ld h, 0
    ld de, wSnakeY
    add hl, de
    ld a, [hl]
    add a, a
    add a, a
    add a, a
    add a, SPRITE_Y_OFFSET
    ld c, a
    pop hl
    ld [hl], c
    inc hl

    ; X = wSnakeX[index]*8 + 8
    push hl
    ld a, [wOamIndex]
    ld l, a
    ld h, 0
    ld de, wSnakeX
    add hl, de
    ld a, [hl]
    add a, a
    add a, a
    add a, a
    add a, 8
    ld c, a
    pop hl
    ld [hl], c
    inc hl

    ld a, TILE_BODY
    ld [hl+], a
    xor a
    ld [hl], a             ; attributes

    ld a, [wOamIndex]
    inc a
    ld [wOamIndex], a
    jr .activeLoop

.hideRest
    ld a, [wOamIndex]
    ld b, a
.hideLoop
    ld a, b
    cp SNAKE_MAX_LEN
    jr nc, .hideDone

    ld a, b
    add a, a
    add a, a
    ld l, a
    ld h, 0
    ld de, OAM_SNAKE_BASE
    add hl, de
    xor a
    ld [hl], a             ; Y=0 hides this sprite

    inc b
    jr .hideLoop
.hideDone
    ret


; ------------------------------------------------------------
; HudSetTile - writes tile id `a` into column `b` (0-19) of the
; HUD bar, which always lives in background tilemap row 0.
; Since row 0 starts at $9800 and each row is 32 bytes, the
; address for column x is simply $9800 + x.
; ------------------------------------------------------------
HudSetTile:
    push af
    ld h, $98
    ld l, b
    pop af
    ld [hl], a
    ret


; ------------------------------------------------------------
; ClampHL999 - clamps the 16-bit value in hl to a maximum of 999
; so it always fits in 3 decimal digits for the HUD.
; ------------------------------------------------------------
ClampHL999:
    ld a, h
    cp 4
    jr nc, .doClamp        ; h>=4 -> value >= 1024, definitely over 999
    cp 3
    jr nz, .noClamp        ; h<3 -> value <= 767, definitely under 999
    ld a, l
    cp 232                 ; 3*256+232 = 1000
    jr c, .noClamp
.doClamp
    ld hl, 999
.noClamp
    ret


; ------------------------------------------------------------
; Bin16ToDec3 - converts the 16-bit value in hl (clamped to
; 0-999) into three decimal digits, stored in wDigH/wDigT/wDigO.
; ------------------------------------------------------------
Bin16ToDec3:
    call ClampHL999

    ld b, 0
.hundredsLoop
    ld a, l
    sub 100
    ld c, a
    ld a, h
    sbc a, 0
    jr c, .hundredsDone
    ld l, c
    ld h, a
    inc b
    jr .hundredsLoop
.hundredsDone
    ld a, b
    ld [wDigH], a

    ld b, 0
.tensLoop
    ld a, l
    sub 10
    ld c, a
    ld a, h
    sbc a, 0
    jr c, .tensDone
    ld l, c
    ld h, a
    inc b
    jr .tensLoop
.tensDone
    ld a, b
    ld [wDigT], a

    ld a, l
    ld [wDigO], a          ; remainder, 0-9
    ret


; ------------------------------------------------------------
; UpdateHUD - redraws the HUD bar (background row 0):
;   column  1: food icon, columns 2-4: score digits
;   column 14: body icon, columns 15-17: time digits (seconds)
; ------------------------------------------------------------
UpdateHUD:
    ; ---- score ----
    ld a, [wScore]
    ld l, a
    ld a, [wScore+1]
    ld h, a
    call Bin16ToDec3

    ld a, TILE_FOOD
    ld b, 1
    call HudSetTile
    ld a, [wDigH]
    add a, DIGIT_TILE_BASE
    ld b, 2
    call HudSetTile
    ld a, [wDigT]
    add a, DIGIT_TILE_BASE
    ld b, 3
    call HudSetTile
    ld a, [wDigO]
    add a, DIGIT_TILE_BASE
    ld b, 4
    call HudSetTile

    ; ---- time ----
    ld a, [wTime]
    ld l, a
    ld a, [wTime+1]
    ld h, a
    call Bin16ToDec3

    ld a, TILE_BODY
    ld b, 14
    call HudSetTile
    ld a, [wDigH]
    add a, DIGIT_TILE_BASE
    ld b, 15
    call HudSetTile
    ld a, [wDigT]
    add a, DIGIT_TILE_BASE
    ld b, 16
    call HudSetTile
    ld a, [wDigO]
    add a, DIGIT_TILE_BASE
    ld b, 17
    call HudSetTile
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
; This same tile block is used both for BG tiles and, since
; sprites always use the $8000 unsigned addressing mode, for
; the snake/food sprites too.
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
; MusicTune - a short looping melody played on channel 2.
; Each entry is a 16-bit note period (see NOTE_ constants above);
; NOTE_REST is a silent beat. MUSIC_LEN must match the entry count.
; ------------------------------------------------------------
MusicTune:
    dw NOTE_E5, NOTE_G5, NOTE_A5, NOTE_G5
    dw NOTE_E5, NOTE_D5, NOTE_C5, NOTE_REST
    dw NOTE_E5, NOTE_G5, NOTE_A5, NOTE_G5
    dw NOTE_F5, NOTE_D5, NOTE_C5, NOTE_REST


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
    ; High bitplane byte is 0, so as a sprite, color-0 pixels
    ; (the background of the tile) are transparent and color-1
    ; pixels (the diamond) are opaque.
    db $18,$00, $3C,$00, $7E,$00, $FF,$00
    db $FF,$00, $7E,$00, $3C,$00, $18,$00

    ; Tiles 3-12: HUD digit font '0'-'9' (solid color 3, black,
    ; on a transparent/white background - both bitplane bytes
    ; are equal, same style as the body tile).
    ; Tile 3: '0'
    db $70,$70, $88,$88, $98,$98, $A8,$A8
    db $C8,$C8, $88,$88, $70,$70, $00,$00
    ; Tile 4: '1'
    db $20,$20, $60,$60, $20,$20, $20,$20
    db $20,$20, $20,$20, $70,$70, $00,$00
    ; Tile 5: '2'
    db $70,$70, $88,$88, $08,$08, $10,$10
    db $20,$20, $40,$40, $F8,$F8, $00,$00
    ; Tile 6: '3'
    db $F8,$F8, $10,$10, $20,$20, $10,$10
    db $08,$08, $88,$88, $70,$70, $00,$00
    ; Tile 7: '4'
    db $10,$10, $30,$30, $50,$50, $90,$90
    db $F8,$F8, $10,$10, $10,$10, $00,$00
    ; Tile 8: '5'
    db $F8,$F8, $80,$80, $F0,$F0, $08,$08
    db $08,$08, $88,$88, $70,$70, $00,$00
    ; Tile 9: '6'
    db $30,$30, $40,$40, $80,$80, $F0,$F0
    db $88,$88, $88,$88, $70,$70, $00,$00
    ; Tile 10: '7'
    db $F8,$F8, $08,$08, $10,$10, $20,$20
    db $40,$40, $40,$40, $40,$40, $00,$00
    ; Tile 11: '8'
    db $70,$70, $88,$88, $88,$88, $70,$70
    db $88,$88, $88,$88, $70,$70, $00,$00
    ; Tile 12: '9'
    db $70,$70, $88,$88, $88,$88, $78,$78
    db $08,$08, $10,$10, $60,$60, $00,$00
