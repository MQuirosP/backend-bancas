import * as fs from 'fs';
import * as path from 'path';

const LOG_FILE = path.join(process.cwd(), 'logs', 'banca-filter-debug.log');

// Asegurar que el directorio existe
const logDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

/**
 * Logger específico para debugging del filtro de banca
 * Escribe a un archivo separado para facilitar el debugging
 */
export const bancaFilterLogger = {
  log: (message: string, data?: any) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}${data ? '\n' + JSON.stringify(data, null, 2) : ''}\n\n`;
    
    // Escribir al archivo
    fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
    
    // También mostrar en consola con formato especial
    console.log(`\n🔍 [BANCA-FILTER] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  },
  
  clear: () => {
    if (fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(LOG_FILE, '', 'utf8');
    }
  },
  
  getLogFile: () => LOG_FILE,
};

