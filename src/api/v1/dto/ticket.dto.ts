export interface CreateTicketDTO {
  loteriaId: string;
  sorteoId: string;
  ventanaId: string;
  vendedorId?: string; // opcional para ADMIN/VENTANA
  clienteNombre?: string | null; // nombre del cliente (opcional)
  jugadas: {
    number: string;
    amount: number;
    type?: "NUMERO" | "REVENTADO";
    reventadoNumber?: string | null;
    multiplierId?: string;  // solo permitido si type = NUMERO
    finalMultiplierX?: number;  // ignorado por el cliente
  }[];
}

export interface TicketResponseDTO {
  id: string;
  ticketNumber: string;  // Formato: TYYMMDD-XXXXXX-CC (ej: T250126-00000A-42)
  totalAmount: number;
  status: string;
  loteriaId: string;
  sorteoId: string;
  ventanaId: string;
  vendedorId: string;
  clienteNombre?: string | null;
  createdAt: Date;
}
