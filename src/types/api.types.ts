/**
 * Tipos para las respuestas de la API
 */

export interface User {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  username: string;
  role: string;
  ventanaId?: string | null;
  code?: string | null;
  isActive: boolean;
  settings?: {
    print?: {
      name?: string | null;
      phone?: string | null;
      width?: 58 | 88 | null;
      footer?: string | null;
      barcode?: boolean | null;
      bluetoothMacAddress?: string | null;
    };
    theme?: 'light' | 'dark' | null;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

