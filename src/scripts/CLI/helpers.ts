import readline from 'readline';
import logger from '../../core/logger';

/**
 * helpers.ts
 * Utilidades compartidas para la suite CLI de Operaciones.
 */

// Silenciar por completo Pino/Logger durante toda la ejecución de la suite CLI
try {
  (logger.raw as any).level = 'silent';
  logger.info = () => {};
  logger.debug = () => {};
  logger.warn = () => {};
} catch (e) {
  // Ignore
}

// Códigos de Color ANSI (Compatibles con PowerShell 7, Windows Terminal, Linux SSH y Render Shell)
export const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  brightCyan: "\x1b[96m",
  green: "\x1b[32m",
  brightGreen: "\x1b[92m",
  yellow: "\x1b[33m",
  brightYellow: "\x1b[93m",
  red: "\x1b[31m",
  brightRed: "\x1b[91m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  brightMagenta: "\x1b[95m",
  white: "\x1b[37m",
  bgYellow: "\x1b[43m\x1b[30m",
  bgRed: "\x1b[41m\x1b[37m",
  bgGreen: "\x1b[42m\x1b[30m",
};

export function clearScreen() {
  process.stdout.write('\x1Bc');
}

export function colorizeStatus(status: string): string {
  if (status === 'OPEN') return `${colors.brightYellow}${colors.bold}OPEN${colors.reset}`;
  if (status === 'EVALUATED') return `${colors.brightGreen}${colors.bold}EVALUATED${colors.reset}`;
  if (status === 'CLOSED') return `${colors.brightRed}${colors.bold}CLOSED${colors.reset}`;
  return status;
}

export function colorizeSorteoId(id: string): string {
  return `${colors.brightCyan}${colors.bold}${id}${colors.reset}`;
}

export function colorizeWinningNumber(num: string | null): string {
  if (!num || num === 'N/A') return `${colors.dim}N/A${colors.reset}`;
  return `${colors.brightMagenta}${colors.bold}${num}${colors.reset}`;
}

export const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

export function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

export function isBack(input: string): boolean {
  const clean = input.toLowerCase();
  return clean === 'b' || clean === 'back' || clean === 'volver' || clean === '-1';
}

export function formatCRC(amount: number): string {
  return new Intl.NumberFormat('es-CR', {
    style: 'currency',
    currency: 'CRC',
    minimumFractionDigits: 2
  }).format(amount);
}

/**
 * Muestra una barra de progreso animada e interactiva en la terminal (línea única con espaciado correcto)
 */
export function renderProgressBar(current: number, total: number, label: string = '') {
  if (total <= 0) return;
  const width = 25;
  const percentage = Math.min(100, Math.floor((current / total) * 100));
  const filled = Math.floor((width * current) / total);
  const empty = width - filled;

  const bar = '='.repeat(filled) + (filled < width ? '>' : '') + ' '.repeat(Math.max(0, empty - 1));
  const truncatedLabel = label.length > 25 ? label.substring(0, 22) + '...' : label;
  const lineText = `\r⏳  [${colors.brightCyan}${bar}${colors.reset}] ${colors.bold}${percentage.toString().padStart(3, ' ')}%${colors.reset} (${current}/${total}) ${truncatedLabel.padEnd(25, ' ')}`;

  process.stdout.write(lineText);

  if (current >= total) {
    process.stdout.write('\r' + ' '.repeat(lineText.length + 5) + '\r');
  }
}
