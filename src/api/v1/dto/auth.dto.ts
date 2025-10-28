export interface RegisterDTO {
    name: string,
    email: string,
    username: string,
    password: string,
    role?: 'ADMIN' | 'VENTANA' | 'VENDEDOR',
    ventanaId?: string,  // UUID de ventana (requerido para VENTANA y VENDEDOR)
}

export interface LoginDTO {
    username: string,
    password: string,
}

export interface TokenPair {
    accessToken: string,
    refreshToken: string,
}