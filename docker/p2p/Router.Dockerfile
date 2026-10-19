ARG ROUTER_BASE
FROM ${ROUTER_BASE}
ARG IPROUTE_VERSION
ARG IPTABLES_VERSION
ARG LIBCAP_VERSION
ARG CONNTRACK_VERSION
RUN apk add --no-cache iproute2=${IPROUTE_VERSION} iptables=${IPTABLES_VERSION} libcap-utils=${LIBCAP_VERSION} conntrack-tools=${CONNTRACK_VERSION} && adduser -D -u 1000 router && setcap cap_net_admin=ep /sbin/ip && setcap cap_net_admin=ep /usr/sbin/xtables-nft-multi && setcap cap_net_admin=ep /usr/sbin/capsh && setcap cap_net_admin=ep /usr/sbin/conntrack
COPY docker/p2p/router.sh /app/router.sh
ENV XTABLES_LOCKFILE=/app/.local/xtables.lock
USER 1000:1000
ENTRYPOINT ["/usr/sbin/capsh", "--shell=/bin/sh", "--inh=cap_net_admin", "--addamb=cap_net_admin", "--no-new-privs", "--", "-c", "exec /bin/sh /app/router.sh"]
