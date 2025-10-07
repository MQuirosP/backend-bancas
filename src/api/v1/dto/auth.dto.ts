export interface RegisterDTO {
    name: string,
    email: string,
    password: string,
    role?: 'ADMIN' | 'VENTANA' | 'VENDEDOR',
}

export interface LoginDTO {
    email: string,
    password: string,
}

export interface TokenPair {
    accessToken: string,
    refreshToken: string,
}