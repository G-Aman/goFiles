# Build stage
FROM golang:1.23-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o gofiles .

# Minimal alpine runtime
FROM alpine:3.20

RUN apk --no-cache add ca-certificates tzdata mailcap

WORKDIR /app

COPY --from=builder /app/gofiles /app/gofiles
COPY config.sample.json /app/config.sample.json
COPY acl.sample.conf /app/acl.sample.conf

# Data directory for config.json, acl.conf, state, and files
VOLUME /data

EXPOSE 9001

ENTRYPOINT ["/app/gofiles"]
CMD ["-config", "/data/config.json", "-root", "/data/files"]
