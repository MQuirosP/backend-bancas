export enum ReportDimension {
  LISTERO = 'listero',
  VENDEDOR = 'vendedor',
  BANCA = 'banca',
  VENTANA = 'ventana',
  LOTERIA = 'loteria',
  SORTEO = 'sorteo',
  NUMERO = 'numero'
}

export enum QueryScope {
  MINE = 'mine',
  ALL = 'all',
  VENTANA = 'ventana'
}

export enum BetTypeFilter {
  NUMERO = 'NUMERO',
  REVENTADO = 'REVENTADO',
  ALL = 'all'
}

export enum SorteoStatusFilter {
  SCHEDULED = 'SCHEDULED',
  OPEN = 'OPEN',
  EVALUATED = 'EVALUATED',
  CLOSED = 'CLOSED',
  ALL = 'all'
}
