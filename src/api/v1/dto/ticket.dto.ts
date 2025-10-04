import { created } from './../../../utils/responses';
export interface CreateTicketDTO {
  loteriaId: string;
  ventanaId: string;
  jugadas: { 
    number: string; 
    amount: number; 
    multiplierId: string 
  }[];
}

export interface TicketResponseDTO {
    id: string;
    ticketNumber: number;
    totalAmount: number;
    status: string;
    loteriaId: string;
    ventanaId: string;
    vendedorId: string;
    createdAt: Date;
}