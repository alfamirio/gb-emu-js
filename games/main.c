#include <gb/gb.h>
#include <stdint.h>
#include <rand.h>

// Game constants
#define GRID_W          20
#define GRID_H          17
#define SNAKE_MAX_LEN   6
#define MOVE_INTERVAL   8
#define SECOND_FRAMES   60

#define DIR_UP          0
#define DIR_DOWN        1
#define DIR_LEFT        2
#define DIR_RIGHT       3

#define TILE_BLANK      0
#define TILE_BODY       1
#define TILE_FOOD       2
#define DIGIT_TILE_BASE 3

#define SPRITE_Y_OFFSET 24

// Note definitions for audio (GBDK-2020 frequencies)
#define NOTE_REST       0
#define NOTE_C4         262
#define NOTE_D4         294
#define NOTE_E4         330
#define NOTE_F4         349
#define NOTE_G4         392
#define NOTE_A4         440
#define NOTE_B4         494
#define NOTE_C5         523
#define NOTE_D5         587
#define NOTE_E5         659
#define NOTE_F5         698
#define NOTE_G5         784
#define NOTE_A5         880

#define NOTE_FRAMES     12
#define MUSIC_LEN       16

const unsigned char tile_data[] = {
    // Tile 0: blank
    0x00,0x00, 0x00,0x00, 0x00,0x00, 0x00,0x00,
    0x00,0x00, 0x00,0x00, 0x00,0x00, 0x00,0x00,
    // Tile 1: solid body block
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    // Tile 2: food (diamond shape)
    0x18,0x00, 0x3C,0x00, 0x7E,0x00, 0xFF,0x00,
    0xFF,0x00, 0x7E,0x00, 0x3C,0x00, 0x18,0x00,
    // Tile 3: '0'
    0x70,0x70, 0x88,0x88, 0x98,0x98, 0xA8,0xA8,
    0xC8,0xC8, 0x88,0x88, 0x70,0x70, 0x00,0x00,
    // Tile 4: '1'
    0x20,0x20, 0x60,0x60, 0x20,0x20, 0x20,0x20,
    0x20,0x20, 0x20,0x20, 0x70,0x70, 0x00,0x00,
    // Tile 5: '2'
    0x70,0x70, 0x88,0x88, 0x08,0x08, 0x10,0x10,
    0x20,0x20, 0x40,0x40, 0xF8,0xF8, 0x00,0x00,
    // Tile 6: '3'
    0xF8,0xF8, 0x10,0x10, 0x20,0x20, 0x10,0x10,
    0x08,0x08, 0x88,0x88, 0x70,0x70, 0x00,0x00,
    // Tile 7: '4'
    0x10,0x10, 0x30,0x30, 0x50,0x50, 0x90,0x90,
    0xF8,0xF8, 0x10,0x10, 0x10,0x10, 0x00,0x00,
    // Tile 8: '5'
    0xF8,0xF8, 0x80,0x80, 0xF0,0xF0, 0x08,0x08,
    0x08,0x08, 0x88,0x88, 0x70,0x70, 0x00,0x00,
    // Tile 9: '6'
    0x30,0x30, 0x40,0x40, 0x80,0x80, 0xF0,0xF0,
    0x88,0x88, 0x88,0x88, 0x70,0x70, 0x00,0x00,
    // Tile 10: '7'
    0xF8,0xF8, 0x08,0x08, 0x10,0x10, 0x20,0x20,
    0x40,0x40, 0x40,0x40, 0x40,0x40, 0x00,0x00,
    // Tile 11: '8'
    0x70,0x70, 0x88,0x88, 0x88,0x88, 0x70,0x70,
    0x88,0x88, 0x88,0x88, 0x70,0x70, 0x00,0x00,
    // Tile 12: '9'
    0x70,0x70, 0x88,0x88, 0x88,0x88, 0x78,0x78,
    0x08,0x08, 0x10,0x10, 0x60,0x60, 0x00,0x00
};

// Background music array
const uint16_t music_tune[MUSIC_LEN] = {
    NOTE_E5, NOTE_G5, NOTE_A5, NOTE_G5,
    NOTE_E5, NOTE_D5, NOTE_C5, NOTE_REST,
    NOTE_E5, NOTE_G5, NOTE_A5, NOTE_G5,
    NOTE_F5, NOTE_D5, NOTE_C5, NOTE_REST
};

// Global game state variables
uint8_t snake_x[SNAKE_MAX_LEN];
uint8_t snake_y[SNAKE_MAX_LEN];
uint8_t snake_length;
uint8_t direction;
uint8_t frame_counter;
uint8_t game_over;

uint8_t food_x;
uint8_t food_y;

uint16_t score;
uint16_t elapsed_time;
uint8_t time_frames;

uint8_t music_index;
uint8_t music_timer;

// External tile graphics declaration
extern const unsigned char tile_data[];

// Audio triggers
void play_sfx_eat() {
    NR10_REG = 0x23; // Sweep period 2, up, shift 3
    NR11_REG = 0xB0; // Duty 50%, length 48
    NR12_REG = 0xF2; // Vol 15, decrease, pace 2
    
    // GBDK macro to set channel 1 frequency and trigger
    uint16_t frequency = 2048 - (131072 / NOTE_C5);
    NR13_REG = (uint8_t)frequency;
    NR14_REG = 0xC0 | (frequency >> 8); 
}

void play_sfx_game_over() {
    NR41_REG = 32;   // Length data
    NR42_REG = 0xF4; // Vol 15, decrease, pace 4
    NR43_REG = 0x23; // Mid-pitched noise
    NR44_REG = 0xC0; // Trigger + length enable
}

void music_update() {
    if (music_timer > 0) {
        music_timer--;
        return;
    }
    music_timer = NOTE_FRAMES;

    uint16_t note = music_tune[music_index];
    if (note == NOTE_REST) {
        NR22_REG = 0x00; // Mute volume
        NR24_REG = 0x80; // Trigger silence
    } else {
        NR22_REG = 0x80; // Vol 8, no envelope sweep
        uint16_t frequency = 2048 - (131072 / note);
        NR23_REG = (uint8_t)frequency;
        NR24_REG = 0x80 | (frequency >> 8); // Trigger note
    }

    music_index++;
    if (music_index >= MUSIC_LEN) {
        music_index = 0;
    }
}

// Layout mechanics
void place_food() {
    food_x = rand() % GRID_W;
    food_y = rand() % GRID_H;
}

void init_game() {
    game_over = 0;
    frame_counter = 0;
    time_frames = 0;
    score = 0;
    elapsed_time = 0;
    direction = DIR_RIGHT;
    snake_length = 3;

    snake_x[0] = 10; snake_y[0] = 9;
    snake_x[1] = 9;  snake_y[1] = 9;
    snake_x[2] = 8;  snake_y[2] = 9;

    // Clear background tilemap (fill with transparent/blank tile index 0)
    fill_bkg_rect(0, 0, 32, 32, TILE_BLANK);
    place_food();
}

void update_oam() {
    // Food -> Hardware Sprite Slot 0
    set_sprite_tile(0, TILE_FOOD);
    move_sprite(0, (food_x * 8) + 8, (food_y * 8) + SPRITE_Y_OFFSET);

    // Active segments -> Slots 1 to SNAKE_MAX_LEN
    for (uint8_t i = 0; i < snake_length; i++) {
        set_sprite_tile(i + 1, TILE_BODY);
        move_sprite(i + 1, (snake_x[i] * 8) + 8, (snake_y[i] * 8) + SPRITE_Y_OFFSET);
    }

    // Hide remaining hardware sprites
    for (uint8_t i = snake_length; i < SNAKE_MAX_LEN; i++) {
        move_sprite(i + 1, 0, 0); 
    }
}

void update_hud() {
    uint16_t temp_score = (score > 999) ? 999 : score;
    uint16_t temp_time = (elapsed_time > 999) ? 999 : elapsed_time;

    // Redraw Score elements on the background layer (Row 0)
    set_bkg_tile_xy(1, 0, TILE_FOOD);
    set_bkg_tile_xy(2, 0, DIGIT_TILE_BASE + (temp_score / 100));
    set_bkg_tile_xy(3, 0, DIGIT_TILE_BASE + ((temp_score % 100) / 10));
    set_bkg_tile_xy(4, 0, DIGIT_TILE_BASE + (temp_score % 10));

    // Redraw Time elements on the background layer (Row 0)
    set_bkg_tile_xy(14, 0, TILE_BODY);
    set_bkg_tile_xy(15, 0, DIGIT_TILE_BASE + (temp_time / 100));
    set_bkg_tile_xy(16, 0, DIGIT_TILE_BASE + ((temp_time % 100) / 10));
    set_bkg_tile_xy(17, 0, DIGIT_TILE_BASE + (temp_time % 10));
}

void move_snake() {
    uint8_t new_x = snake_x[0];
    uint8_t new_y = snake_y[0];

    if (direction == DIR_UP) new_y--;
    else if (direction == DIR_DOWN) new_y++;
    else if (direction == DIR_LEFT) new_x--;
    else if (direction == DIR_RIGHT) new_x++;

    // Wall collision checks
    if (new_x >= GRID_W || new_y >= GRID_H) {
        game_over = 1;
        play_sfx_game_over();
        return;
    }

    uint8_t will_eat = (new_x == food_x && new_y == food_y);

    // Self-collision checking loop
    uint8_t check_count = will_eat ? snake_length : (snake_length - 1);
    for (uint8_t i = 0; i < check_count; i++) {
        if (new_x == snake_x[i] && new_y == snake_y[i]) {
            game_over = 1;
            play_sfx_game_over();
            return;
        }
    }

    // Snake Growth mechanics capped at SNAKE_MAX_LEN
    if (will_eat && snake_length < SNAKE_MAX_LEN) {
        snake_length++;
    }

    // Shift data array elements backwards
    for (uint8_t i = snake_length - 1; i > 0; i--) {
        snake_x[i] = snake_x[i - 1];
        snake_y[i] = snake_y[i - 1];
    }

    // Set new head location
    snake_x[0] = new_x;
    snake_y[0] = new_y;

    if (will_eat) {
        score += 10;
        play_sfx_eat();
        place_food();
    }
}

void check_input() {
    uint8_t joy = joypad();

    if ((joy & J_UP) && direction != DIR_DOWN)     direction = DIR_UP;
    if ((joy & J_DOWN) && direction != DIR_UP)     direction = DIR_DOWN;
    if ((joy & J_LEFT) && direction != DIR_RIGHT)  direction = DIR_LEFT;
    if ((joy & J_RIGHT) && direction != DIR_LEFT)  direction = DIR_RIGHT;
}

void main(void) {
    DISPLAY_OFF;

    // Seed GBDK pseudorandom engine using hardware divider register entropy
    initrand(DIV_REG);

    // Initialize display registers matching assembly configurations
    BGP_REG = 0xE4;  // Palette mapping %11100100
    OBP0_REG = 0xE4; 

    // Audio Control Register setups
    NR52_REG = 0x80; // APU flag active
    NR50_REG = 0x77; // Max master volume
    NR51_REG = 0xFF; // Direct channel panning
    NR21_REG = 0x80; // Channel 2 duty setup

    music_index = 0;
    music_timer = 0;

    // Load graphical arrays into Game Boy VRAM memory
    set_bkg_data(0, 13, tile_data);
    set_sprite_data(0, 13, tile_data);

    init_game();
    
    DISPLAY_ON;
    SHOW_BKG;
    SHOW_SPRITES;

    while (1) {
        wait_vbl_done(); // Wait for VBlank vertical synchronization frame interrupt
        
        update_oam();
        update_hud();
        music_update();
        check_input();

        if (game_over) {
            if (joypad() & J_START) {
                init_game();
            }
            continue;
        }

        // Keep track of runtime processing clocks for HUD metric 
        time_frames++;
        if (time_frames >= SECOND_FRAMES) {
            time_frames = 0;
            elapsed_time++;
        }

        frame_counter++;
        if (frame_counter >= MOVE_INTERVAL) {
            frame_counter = 0;
            move_snake();
        }
    }
}
