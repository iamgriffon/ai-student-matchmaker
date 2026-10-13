import { getAgeStats, getScoreStats } from "../../db/users";

async function age(age: number): Promise<number> {
  const averageAge = await getAgeStats();
  return age / averageAge;
}

async function score(score: number): Promise<number> {
  const averageScore = await getScoreStats();
  return score / averageScore;
}

export const normalizers = {
  age,
  score,
};
