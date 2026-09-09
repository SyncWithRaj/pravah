import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from './metrics.service';
import { Request, Response } from 'express';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const start = performance.now();
    const method = req.method || 'GET';
    const path = req.baseUrl || req.path || '/';

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = (performance.now() - start) / 1000;
          const statusCode = String(res.statusCode || 200);
          this.metricsService.httpRequestsTotal.inc({
            method,
            route: path,
            status_code: statusCode,
          });
          this.metricsService.httpRequestDuration.observe(
            { method, route: path, status_code: statusCode },
            duration,
          );
        },
        error: (err: unknown) => {
          const duration = (performance.now() - start) / 1000;
          const errObj = err as { status?: number; statusCode?: number } | null;
          const statusCode = String(
            errObj?.status || errObj?.statusCode || 500,
          );
          this.metricsService.httpRequestsTotal.inc({
            method,
            route: path,
            status_code: statusCode,
          });
          this.metricsService.httpRequestDuration.observe(
            { method, route: path, status_code: statusCode },
            duration,
          );
        },
      }),
    );
  }
}
