import { Skill } from "./entities/skill.entity";

// NOTE: This module currently exposes no SkillsService (only the Skill entity
// is registered in SkillsModule). The spec verifies the entity contract until a
// service is introduced.
describe("Skills", () => {
  it("should expose the Skill entity", () => {
    expect(Skill).toBeDefined();
    const skill = new Skill();
    expect(skill).toBeInstanceOf(Skill);
  });
});
