FROM gradle:7.6.4-jdk17-alpine AS engine-build
WORKDIR /src
COPY engine/ .
RUN ./gradlew --no-daemon clean bootJar

FROM node:20-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jre-headless wget tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --home /app --shell /usr/sbin/nologin crypto
WORKDIR /app
COPY --from=engine-build /src/build/libs/*.jar /app/fidelius-engine.jar
COPY facade/ /app/facade/
COPY entrypoint.sh /app/entrypoint.sh
RUN chown -R crypto:crypto /app
USER crypto
ENV PORT=8090 FIDELIUS_ENGINE_URL=http://127.0.0.1:8091
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O- http://127.0.0.1:8090/health >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini","--","/app/entrypoint.sh"]
