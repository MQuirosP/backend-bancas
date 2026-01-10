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
    platform?: 'web' | 'android' | 'ios',  // Opcional: Plataforma del cliente
    appVersion?: string,  // Opcional: Versión de la aplicación (ej: '2.0.7')
}

export interface TokenPair {
    accessToken: string,
    refreshToken: string,
}