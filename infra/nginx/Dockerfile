FROM nginx:1.27-alpine

# Create cache directories and set ownership for unprivileged nginx worker
RUN mkdir -p /var/cache/nginx/edge_segments \
             /var/cache/nginx/edge_manifests \
             /var/log/nginx \
    && chown -R nginx:nginx /var/cache/nginx /var/log/nginx

# Remove default configuration
RUN rm -f /etc/nginx/conf.d/default.conf

# Copy tuned configurations
COPY nginx.conf /etc/nginx/nginx.conf
COPY conf.d/edge.conf /etc/nginx/conf.d/edge.conf

# Test configuration during image build
RUN nginx -t

# Liveness probe
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/healthz || exit 1

EXPOSE 80

STOPSIGNAL SIGQUIT

CMD ["nginx", "-g", "daemon off;"]
