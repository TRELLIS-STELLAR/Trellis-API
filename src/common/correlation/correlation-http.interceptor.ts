import { Injectable, Logger } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { AxiosRequestConfig, AxiosResponse, AxiosError } from "axios";
import {
  getCorrelationId,
  withCorrelationHeaders,
} from "./correlation-context";

/**
 * HTTP client interceptor that automatically adds correlation headers to all outbound requests.
 * This ensures correlation IDs propagate across service boundaries.
 * 
 * Register this service in your module and it will automatically configure axios interceptors.
 */
@Injectable()
export class CorrelationHttpInterceptor {
  private readonly logger = new Logger(CorrelationHttpInterceptor.name);

  constructor(private readonly httpService: HttpService) {
    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    // Request interceptor - add correlation headers
    this.httpService.axiosRef.interceptors.request.use(
      (config: AxiosRequestConfig) => {
        const correlationId = getCorrelationId();
        if (correlationId) {
          config.headers = withCorrelationHeaders(
            config.headers as Record<string, string> || {},
            correlationId,
          );

          this.logger.debug({
            correlationId,
            url: config.url,
            method: config.method?.toUpperCase(),
            message: "Outbound HTTP request with correlation",
          });
        }
        return config;
      },
      (error: AxiosError) => {
        this.logger.error({
          correlationId: getCorrelationId(),
          error: error.message,
          message: "HTTP request setup failed",
        });
        return Promise.reject(error);
      },
    );

    // Response interceptor - log correlation on response/error
    this.httpService.axiosRef.interceptors.response.use(
      (response: AxiosResponse) => {
        const correlationId = getCorrelationId();
        this.logger.debug({
          correlationId,
          url: response.config.url,
          status: response.status,
          message: "Outbound HTTP response received",
        });
        return response;
      },
      (error: AxiosError) => {
        const correlationId = getCorrelationId();
        this.logger.error({
          correlationId,
          url: error.config?.url,
          status: error.response?.status,
          error: error.message,
          message: "Outbound HTTP request failed",
        });
        return Promise.reject(error);
      },
    );
  }
}
