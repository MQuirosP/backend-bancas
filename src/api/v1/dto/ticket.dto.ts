// import { created } from './../../../utils/responses'; // ← sobra, lo removemos

export interface CreateTicketDTO {
  loteriaId: string;
  sorteoId: string;  // 👈 nuevo
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
  sorteoId: string;  // 👈 nuevo
  ventanaId: string;
  vendedorId: string;
  createdAt: Date;
}
