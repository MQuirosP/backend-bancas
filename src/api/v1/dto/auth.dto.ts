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
    // Campos para tracking de dispositivos (multi-dispositivo)
    deviceId?: string,    // UUID persistente generado por el cliente
    deviceName?: string,  // Nombre legible: "Chrome · Windows", "Samsung Galaxy S23"
}

export interface RequestContext {
    userAgent?: string,
    ipAddress?: string,
}

export interface TokenPair {
    accessToken: string,
    refreshToken: string,
}