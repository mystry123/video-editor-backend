import request from 'supertest';
import app from '../src/app';
import { User } from '../src/models/User';
import { generateAccessToken } from '../src/utils/jwt';

export const api = () => request(app);

let counter = 0;

/** Creates a user directly in the database and returns it with a bearer token. */
export async function createUser(overrides: Partial<{ email: string; password: string; role: string; name: string }> = {}) {
  counter++;
  const user = await User.create({
    email: overrides.email || `user${counter}-${Date.now()}@test.dev`,
    password: overrides.password ?? 'Password123',
    role: overrides.role || 'free',
    name: overrides.name || `Test User ${counter}`,
  });
  const token = generateAccessToken({ userId: user._id.toString(), email: user.email, role: user.role });
  return { user, token, auth: { Authorization: `Bearer ${token}` } };
}
