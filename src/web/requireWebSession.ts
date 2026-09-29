import type { NextFunction, Request, Response } from 'express';

/**
 * Exige sesion iniciada para las paginas de la interfaz web de almacen (/almacen/*, salvo login).
 * Si no hay sesion (o no tiene `userId`), redirige a la pantalla de login en vez de devolver un
 * error JSON: esta interfaz la usan personas en un navegador, no sistemas.
 */
export function requireWebSession(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.userId) {
    next();
    return;
  }
  res.redirect('/almacen/login');
}
