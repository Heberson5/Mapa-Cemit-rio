// Copia as bibliotecas de front-end para public/vendor (sem depender de CDN no totem).
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('public/vendor', { recursive: true });
cpSync('node_modules/maplibre-gl/dist/maplibre-gl.js', 'public/vendor/maplibre-gl.js');
cpSync('node_modules/maplibre-gl/dist/maplibre-gl.css', 'public/vendor/maplibre-gl.css');
cpSync('node_modules/xlsx/dist/xlsx.full.min.js', 'public/vendor/xlsx.full.min.js');
console.log('vendor ok');
