import { OwnershipTransferService } from "./ownership-transfer.service";
import { OwnershipTransferStatus } from "./entities/ownership-transfer.entity";
import {
  BadRequestException,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";

describe("OwnershipTransferService", () => {
  let service: OwnershipTransferService;

  beforeEach(() => {
    service = new OwnershipTransferService();
  });

  describe("Initiating Ownership Transfer", () => {
    it("should successfully initiate a pending ownership transfer with expiration", async () => {
      const transfer = await service.initiateTransfer({
        resourceType: "portfolio",
        resourceId: "port-12345",
        currentOwnerId: "user-alice",
        proposedOwnerId: "user-bob",
        expiresInHours: 48,
      });

      expect(transfer.id).toBeDefined();
      expect(transfer.resourceType).toBe("portfolio");
      expect(transfer.resourceId).toBe("port-12345");
      expect(transfer.currentOwnerId).toBe("user-alice");
      expect(transfer.proposedOwnerId).toBe("user-bob");
      expect(transfer.status).toBe(OwnershipTransferStatus.PENDING);

      const expectedExpiry = Date.now() + 48 * 60 * 60 * 1000;
      expect(new Date(transfer.expiresAt).getTime()).toBeGreaterThanOrEqual(expectedExpiry - 2000);
      expect(new Date(transfer.expiresAt).getTime()).toBeLessThanOrEqual(expectedExpiry + 2000);
    });

    it("should reject self-transfer attempt", async () => {
      await expect(
        service.initiateTransfer({
          resourceType: "portfolio",
          resourceId: "port-12345",
          currentOwnerId: "user-alice",
          proposedOwnerId: "user-alice",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject duplicate pending transfer for the same resource", async () => {
      await service.initiateTransfer({
        resourceType: "wallet",
        resourceId: "wall-001",
        currentOwnerId: "user-alice",
        proposedOwnerId: "user-bob",
      });

      await expect(
        service.initiateTransfer({
          resourceType: "wallet",
          resourceId: "wall-001",
          currentOwnerId: "user-alice",
          proposedOwnerId: "user-charlie",
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("Accepting Ownership Transfer", () => {
    it("should allow proposed owner to accept pending transfer", async () => {
      const transfer = await service.initiateTransfer({
        resourceType: "organization",
        resourceId: "org-alpha",
        currentOwnerId: "user-alice",
        proposedOwnerId: "user-bob",
      });

      const accepted = await service.acceptTransfer(transfer.id, "user-bob");
      expect(accepted.status).toBe(OwnershipTransferStatus.ACCEPTED);
      expect(accepted.acceptedAt).toBeInstanceOf(Date);
    });

    it("should forbid unauthorized users from accepting transfer", async () => {
      const transfer = await service.initiateTransfer({
        resourceType: "organization",
        resourceId: "org-alpha",
        currentOwnerId: "user-alice",
        proposedOwnerId: "user-bob",
      });

      await expect(service.acceptTransfer(transfer.id, "user-imposter")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("should reject acceptance if transfer has expired", async () => {
      const transfer = await service.initiateTransfer({
        resourceType: "organization",
        resourceId: "org-alpha",
        currentOwnerId: "user-alice",
        proposedOwnerId: "user-bob",
      });

      // Manually simulate past expiration
      transfer.expiresAt = new Date(Date.now() - 1000);

      await expect(service.acceptTransfer(transfer.id, "user-bob")).rejects.toThrow(
        /expired/,
      );

      const updated = await service.getTransfer(transfer.id);
      expect(updated.status).toBe(OwnershipTransferStatus.EXPIRED);
    });
  });

  describe("Cancelling and Rejecting Ownership Transfer", () => {
    it("should allow current owner to cancel a pending transfer", async () => {
      const transfer = await service.initiateTransfer({
        resourceType: "apiKey",
        resourceId: "key-999",
        currentOwnerId: "user-alice",
        proposedOwnerId: "user-bob",
      });

      const cancelled = await service.cancelTransfer(
        transfer.id,
        "user-alice",
        "Wrong recipient email",
      );

      expect(cancelled.status).toBe(OwnershipTransferStatus.CANCELLED);
      expect(cancelled.cancellationReason).toBe("Wrong recipient email");
      expect(cancelled.cancelledAt).toBeInstanceOf(Date);

      // Subsequent accept should fail
      await expect(service.acceptTransfer(transfer.id, "user-bob")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should forbid non-initiator from cancelling transfer", async () => {
      const transfer = await service.initiateTransfer({
        resourceType: "apiKey",
        resourceId: "key-999",
        currentOwnerId: "user-alice",
        proposedOwnerId: "user-bob",
      });

      await expect(service.cancelTransfer(transfer.id, "user-bob")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("should allow proposed owner to reject transfer", async () => {
      const transfer = await service.initiateTransfer({
        resourceType: "portfolio",
        resourceId: "port-999",
        currentOwnerId: "user-alice",
        proposedOwnerId: "user-bob",
      });

      const rejected = await service.rejectTransfer(
        transfer.id,
        "user-bob",
        "Not interested",
      );

      expect(rejected.status).toBe(OwnershipTransferStatus.REJECTED);
      expect(rejected.rejectionReason).toBe("Not interested");
      expect(rejected.rejectedAt).toBeInstanceOf(Date);
    });
  });

  describe("Querying Transfers", () => {
    it("should list incoming and outgoing transfers accurately", async () => {
      await service.initiateTransfer({
        resourceType: "p1",
        resourceId: "1",
        currentOwnerId: "user-alice",
        proposedOwnerId: "user-bob",
      });
      await service.initiateTransfer({
        resourceType: "p2",
        resourceId: "2",
        currentOwnerId: "user-bob",
        proposedOwnerId: "user-alice",
      });

      const incomingForAlice = await service.listTransfers("user-alice", "incoming");
      expect(incomingForAlice).toHaveLength(1);
      expect(incomingForAlice[0].resourceId).toBe("2");

      const outgoingForAlice = await service.listTransfers("user-alice", "outgoing");
      expect(outgoingForAlice).toHaveLength(1);
      expect(outgoingForAlice[0].resourceId).toBe("1");
    });
  });
});
