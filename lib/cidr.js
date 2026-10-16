'use strict';

const net = require('node:net');

// Normalizes an IP literal: strips brackets and unwraps IPv4-mapped IPv6. Returns null if not an IP.
function normalizeIp(value)
{
    if (typeof value !== 'string') return null;
    let ip = value.trim();
    if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (mapped) ip = mapped[1];
    return net.isIP(ip) ? ip : null;
}

// Parses an IP address or CIDR range; throws on anything else.
function parseCidr(value)
{
    const [address, length, extra] = String(value).split('/');
    const ip = normalizeIp(address);
    if (!ip || extra !== undefined) throw new Error('Invalid IP address or CIDR range');
    const family = net.isIPv4(ip) ? 'ipv4' : 'ipv6';
    const max = family === 'ipv4' ? 32 : 128;
    if (length !== undefined && !/^\d{1,3}$/.test(length)) throw new Error('Invalid CIDR prefix');
    const prefix = length === undefined ? max : Number(length);
    if (prefix > max) throw new Error('Invalid CIDR prefix');
    return { ip, family, prefix };
}

function ipInCidr(value, cidr)
{
    const ip = normalizeIp(value);
    if (!ip) return false;
    let range;
    try { range = parseCidr(cidr); } catch { return false; }
    const list = new net.BlockList();
    list.addSubnet(range.ip, range.prefix, range.family);
    return list.check(ip, net.isIPv4(ip) ? 'ipv4' : 'ipv6');
}

module.exports = { normalizeIp, parseCidr, ipInCidr };
