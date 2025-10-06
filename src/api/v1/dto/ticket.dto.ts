export interface CreateTicketDTO {
  loteriaId: string;
  sorteoId: string;
  ventanaId: string;
  jugadas: {
    number: string;
    amount: number;
    multiplierId: string; // lo dejamos requerido como en tu repo
  }[];
}

export interface TicketResponseDTO {
  id: string;
  ticketNumber: number;
  totalAmount: number;
  status: string;
  loteriaId: string;
  sorteoId: string;
  ventanaId: string;
  vendedorId: string;
  createdAt: Date;
}
