import { PermissionFlagsBits, type GuildMember } from 'discord.js';

type MemberLike = Pick<GuildMember, 'permissions'> & { roles: { cache: { has(id: string): boolean } } };

/**
 * Who may start, stop and pause recordings. Anyone, unless a recorder role is configured;
 * then only members with that role or the Manage Server permission.
 */
export function canControlRecording(member: MemberLike, recorderRoleId: string | undefined): boolean {
  if (!recorderRoleId) return true;
  return member.roles.cache.has(recorderRoleId) || member.permissions.has(PermissionFlagsBits.ManageGuild);
}
