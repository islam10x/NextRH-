import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as dns from 'dns';
import * as cookieParser from 'cookie-parser';
import * as express from 'express';
import * as path from 'path';

dns.setDefaultResultOrder('ipv4first');

function buildAllowedOrigins(frontendUrl: string): string[] {
  const configuredOrigins = frontendUrl
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const localOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
  return Array.from(new Set([...configuredOrigins, ...localOrigins]));
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  const host = configService.get<string>('HOST', '0.0.0.0');
  const frontendUrl = configService.get<string>('FRONTEND_URL', 'http://localhost:5173');
  const allowedOrigins = buildAllowedOrigins(frontendUrl);
  app.use(cookieParser());
  app.use(
    '/public/cv-database',
    express.static(path.resolve(process.cwd(), 'file-storage', 'CV_Database')),
  );
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-session-id'],
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(port, host);
}
bootstrap();
