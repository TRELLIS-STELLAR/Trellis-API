import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  TooManyRequestsException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { MoreThan, Repository } from "typeorm";
import { AgentReview, ReviewStatus } from "./entities/agent-review.entity";
import {
  CreateReviewDto,
  DeveloperResponseDto,
  ModerateReviewDto,
  ReviewQueryDto,
} from "./dto/review.dto";
import { CursorPaginationService } from "src/common/pagination/cursor-pagination.service";

export const DEFAULT_REVIEW_PAGE_SIZE = 20;
export const MAX_REVIEW_PAGE_SIZE = 50;
export const REVIEW_RATE_LIMIT_MS = 24 * 60 * 60 * 1000;
export const REVIEW_SIMILARITY_LOOKBACK = 500;
export const REVIEW_DUPLICATE_SIMILARITY = 0.8;

export interface AgentReviewEdge {
  cursor: string;
  node: AgentReview;
}

export interface AgentReviewConnection {
  edges: AgentReviewEdge[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
}

/** Lightweight spam scoring; suspicious content is routed to moderation. */
function computeSpamScore(text: string): number {
  if (!text) return 0;
  const spamPatterns = [
    /\b(buy|sell|cheap|discount|free|click\s+here)\b/gi,
    /(?:https?:\/\/|www\.)\S+/gi,
    /(.)\1{4,}/g, // repeated chars e.g. "aaaaa"
    /[A-Z]{5,}/g, // long uppercase runs
  ];
  let hits = 0;
  for (const p of spamPatterns) {
    const m = text.match(p);
    if (m) hits += m.length;
  }
  return Math.min(1, hits / 10);
}

function normalizeReviewText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function reviewTokenSet(text: string): Set<string> {
  return new Set(normalizeReviewText(text).split(/\s+/).filter(Boolean));
}

function jaccardSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeReviewText(left);
  const normalizedRight = normalizeReviewText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;

  const leftTokens = reviewTokenSet(left);
  const rightTokens = reviewTokenSet(right);
  // Short phrases contain too little information to distinguish a copied
  // review from ordinary shared wording.
  if (leftTokens.size < 5 || rightTokens.size < 5) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function containsSuspiciousSpam(text: string): boolean {
  const containsLink = /(?:https?:\/\/|www\.)\S+/i.test(text);
  const hasRepetitiveCharacters = /(.)\1{5,}/iu.test(text);
  return containsLink || hasRepetitiveCharacters;
}

export interface AgentRatingAggregation {
  agentId: string;
  averageRating: number;
  totalReviews: number;
  ratingDistribution: Record<number, number>;
}

@Injectable()
export class AgentReviewsService {
  constructor(
    @InjectRepository(AgentReview)
    private readonly reviewRepo: Repository<AgentReview>,
    private readonly cursorPagination: CursorPaginationService,
  ) {}

  /**
   * Submit a review. Only one review per user per agent (enforced at DB + service level).
   * The caller must have used the agent (verified upstream — hasUsedAgent flag passed in).
   */
  async createReview(
    userId: string,
    dto: CreateReviewDto,
    hasUsedAgent: boolean,
  ): Promise<AgentReview> {
    if (!hasUsedAgent) {
      throw new ForbiddenException(
        "Only users who have used this agent can review it",
      );
    }

    const recent = await this.reviewRepo.findOne({
      where: {
        agentId: dto.agentId,
        userId,
        createdAt: MoreThan(new Date(Date.now() - REVIEW_RATE_LIMIT_MS)),
      },
    });
    if (recent) {
      throw new TooManyRequestsException(
        "You can submit one review for this agent every 24 hours",
      );
    }

    const existing = await this.reviewRepo.findOne({
      where: { agentId: dto.agentId, userId },
    });
    if (existing) {
      throw new ConflictException("You have already reviewed this agent");
    }

    const reviewText = dto.reviewText ?? "";
    const similarReviews = await this.reviewRepo.find({
      where: { agentId: dto.agentId },
      select: ["reviewText"],
      order: { createdAt: "DESC" },
      take: REVIEW_SIMILARITY_LOOKBACK,
    });
    const duplicate = similarReviews.some(
      (candidate) =>
        candidate.reviewText &&
        jaccardSimilarity(reviewText, candidate.reviewText) >=
          REVIEW_DUPLICATE_SIMILARITY,
    );
    if (duplicate) {
      throw new ConflictException(
        "This review is too similar to an existing review for this agent",
      );
    }

    const spamScore = computeSpamScore(reviewText);
    const status =
      spamScore >= 0.5 || containsSuspiciousSpam(reviewText)
        ? ReviewStatus.FLAGGED
        : ReviewStatus.PENDING;

    const review = this.reviewRepo.create({
      agentId: dto.agentId,
      userId,
      rating: dto.rating,
      reviewText: dto.reviewText ?? null,
      spamScore,
      status,
    });

    return this.reviewRepo.save(review);
  }

  /** Get approved reviews for an agent (for public discovery). */
  async getApprovedReviews(agentId: string): Promise<AgentReview[]> {
    return this.reviewRepo.find({
      where: { agentId, status: ReviewStatus.APPROVED },
      order: { createdAt: "DESC" },
    });
  }

  /**
   * Get approved reviews with stable keyset pagination. Fetching one extra row
   * determines `hasNextPage` without an expensive count query.
   */
  async getApprovedReviewsConnection(
    agentId: string,
    first = DEFAULT_REVIEW_PAGE_SIZE,
    after?: string,
  ): Promise<AgentReviewConnection> {
    if (!Number.isInteger(first) || first < 1 || first > MAX_REVIEW_PAGE_SIZE) {
      throw new BadRequestException(
        `first must be an integer between 1 and ${MAX_REVIEW_PAGE_SIZE}`,
      );
    }

    const query = this.reviewRepo
      .createQueryBuilder("review")
      .where("review.agentId = :agentId", { agentId })
      .andWhere("review.status = :status", {
        status: ReviewStatus.APPROVED,
      });

    this.cursorPagination.applyDescendingKeyset(query, "review", after);
    const rows = await query.take(first + 1).getMany();
    const hasNextPage = rows.length > first;
    const page = hasNextPage ? rows.slice(0, first) : rows;
    const edges = page.map((node) => ({
      node,
      cursor: this.cursorPagination.encode({
        createdAt: node.createdAt,
        id: node.id,
      }),
    }));

    return {
      edges,
      pageInfo: {
        hasNextPage,
        hasPreviousPage: Boolean(after),
        startCursor: edges[0]?.cursor ?? null,
        endCursor: edges[edges.length - 1]?.cursor ?? null,
      },
    };
  }

  /** Aggregate ratings for an agent — used by scoring engine. */
  async getAggregation(agentId: string): Promise<AgentRatingAggregation> {
    const reviews = await this.reviewRepo.find({
      where: { agentId, status: ReviewStatus.APPROVED },
      select: ["rating"],
    });

    const distribution: Record<number, number> = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
    };
    let sum = 0;
    for (const r of reviews) {
      distribution[r.rating] = (distribution[r.rating] ?? 0) + 1;
      sum += r.rating;
    }

    return {
      agentId,
      averageRating: reviews.length ? sum / reviews.length : 0,
      totalReviews: reviews.length,
      ratingDistribution: distribution,
    };
  }

  /** Developer responds to a review on their agent. */
  async addDeveloperResponse(
    reviewId: string,
    developerId: string,
    dto: DeveloperResponseDto,
  ): Promise<AgentReview> {
    const review = await this.findOrFail(reviewId);
    // In a real system, verify developerId owns the agent. Here we accept the claim.
    review.developerResponse = dto.response;
    review.developerRespondedAt = new Date();
    return this.reviewRepo.save(review);
  }

  /** Admin moderation: approve / reject / flag a review. */
  async moderateReview(
    reviewId: string,
    dto: ModerateReviewDto,
  ): Promise<AgentReview> {
    const review = await this.findOrFail(reviewId);
    review.status = dto.status as ReviewStatus;
    if (dto.moderationNote) review.moderationNote = dto.moderationNote;
    return this.reviewRepo.save(review);
  }

  /** Moderation dashboard: list reviews by status (admin only). */
  async listForModeration(query: ReviewQueryDto): Promise<AgentReview[]> {
    const where: Partial<AgentReview> = {};
    if (query.agentId) where.agentId = query.agentId;
    if (query.status) where.status = query.status as ReviewStatus;
    return this.reviewRepo.find({ where, order: { createdAt: "DESC" } });
  }

  /**
   * Return the average user rating for an agent (approved reviews only).
   * Used by AgentScoring to feed the userRating field (0–5).
   */
  async getUserRatingForScoring(agentId: string): Promise<number> {
    const { averageRating } = await this.getAggregation(agentId);
    return averageRating;
  }

  private async findOrFail(id: string): Promise<AgentReview> {
    const review = await this.reviewRepo.findOne({ where: { id } });
    if (!review) throw new NotFoundException(`Review ${id} not found`);
    return review;
  }
}
