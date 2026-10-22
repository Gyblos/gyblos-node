#!/bin/sh
set -eu
IP=/sbin/ip
IPTABLES=/usr/sbin/iptables-nft
HOME_INTERFACE=$($IP -o -4 addr show | awk -v address="$HOME_ADDRESS" '$4 == address {print $2}')
WAN_INTERFACE=$($IP -o -4 addr show | awk -v address="$WAN_ADDRESS" '$4 == address {print $2}')
test -n "$HOME_INTERFACE"
test -n "$WAN_INTERFACE"
$IP addr add "$HOME_GATEWAY" dev "$HOME_INTERFACE"
# Reject unsolicited router-local UDP before it can reserve a conntrack tuple.
# Replies translated to a home peer use FORWARD and remain eligible below.
$IPTABLES -A INPUT -i "$WAN_INTERFACE" -p udp -m conntrack --ctstate NEW -j DROP
$IPTABLES -P FORWARD DROP
$IPTABLES -A FORWARD -d "$OTHER_HOME_CIDR" -j DROP
if [ "$BLOCK_UDP" = "1" ]; then
  $IPTABLES -A FORWARD -i "$WAN_INTERFACE" -p udp -j DROP
fi
$IPTABLES -A FORWARD -i "$WAN_INTERFACE" -o "$HOME_INTERFACE" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
$IPTABLES -A FORWARD -i "$HOME_INTERFACE" -o "$WAN_INTERFACE" -j ACCEPT
$IPTABLES -t nat -A POSTROUTING -s "$HOME_CIDR" -o "$WAN_INTERFACE" -j MASQUERADE
cat /proc/self/status > /app/.local/status.txt
touch /app/.local/ready
exec sleep infinity
