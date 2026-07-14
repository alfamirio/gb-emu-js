// scripts/check-encapsulation.js
const fs = require('fs');
const path = require('path');

const disallowedPattern = /emulator\.(mmu|cpu|ppu|timer|joypad|apu)\b/g;
const guardedFiles = ['emu-gb-app.js', 'emu-gb-debug.js', 'index.html'];

function checkFiles() {
  let violationsFound = false;

  guardedFiles.forEach(fileName => {
    const filePath = path.join(__dirname, '../', fileName); // Ajusta la ruta según tu estructura
    
    if (!fs.existsSync(filePath)) {
      console.warn(`Archivo no encontrado, omitiendo: ${fileName}`);
      return;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      if (disallowedPattern.test(line)) {
        console.error(`[Encapsulation Violation] ${fileName}:${index + 1}: ${line.trim()}`);
        violationsFound = true;
      }
    });
  });

  if (violationsFound) {
    console.error('\nBuild failed: Encapsulation violations detected.');
    process.exit(1);
  } else {
    console.log('Encapsulation check passed.');
    process.exit(0);
  }
}

checkFiles();
