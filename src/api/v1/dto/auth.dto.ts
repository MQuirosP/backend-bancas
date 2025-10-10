export interface RegisterDTO {
    name: string,
    email: string,
    username: string,
    password: string,
    role?: 'ADMIN' | 'VENTANA' | 'VENDEDOR',
}

export interface LoginDTO {
    username: string,
    password: string,
}

export interface TokenPair {
    accessToken: string,
    refreshToken: string,
}