/**
 * Tipos para los modelos de datos
 */

export interface Usuario {
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

export interface Ventana {
  id: string;
  bancaId: string;
  name: string;
  code: string;
  commissionMarginX: number;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
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

