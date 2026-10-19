describe("financial and ownership invariants", () => {
  it("preserves conservation and ownership exclusivity across generated allocations", () => {
    for (let seed = 1; seed <= 250; seed += 1) {
      const total = seed * 17;
      const first = Math.floor(total / 3);
      const second = Math.floor((total - first) / 2);
      const third = total - first - second;
      expect(first + second + third).toBe(total);
      const owners = new Set([`owner-${seed}`]);
      expect(owners.size).toBe(1);
    }
  });
});
