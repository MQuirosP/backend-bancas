// src/api/v1/dto/sorteosAuto.dto.ts
import { z } from 'zod';
import { UpdateSorteosAutoConfigSchema } from '../validators/sorteosAuto.validator';

export type UpdateSorteosAutoConfigDTO = z.infer<typeof UpdateSorteosAutoConfigSchema>;

