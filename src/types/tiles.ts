/**
 * Tile suits (牌の種類)
 */
export type TileSuit = 'man' | 'pin' | 'sou' | 'honor';

/**
 * Honor tile types (字牌の種類)
 */
export type HonorType = 'east' | 'south' | 'west' | 'north' | 'white' | 'green' | 'red';

/**
 * Tile representation
 * For suited tiles: suit + rank (1-9)
 * For honors: suit='honor' + honorType
 */
export interface Tile {
  suit: TileSuit;
  rank?: number;      // 1-9 for suited tiles
  honorType?: HonorType;  // for honor tiles
  isRed?: boolean;    // red dora (5 man/pin/sou only)
}

/**
 * Tile ID (unique identifier for each physical tile)
 */
export type TileId = string;

/**
 * Tile instance (physical tile with ID)
 */
export interface TileInstance extends Tile {
  id: TileId;
}

/**
 * Convert tile to string representation
 */
export function tileToString(tile: Tile): string {
  if (tile.suit === 'honor') {
    return tile.honorType!;
  }
  const red = tile.isRed ? 'r' : '';
  return `${red}${tile.rank}${tile.suit}`;
}

/**
 * Parse tile from string
 */
export function parseTile(str: string): Tile {
  const honors: Record<string, HonorType> = {
    'east': 'east', 'south': 'south', 'west': 'west', 'north': 'north',
    'white': 'white', 'green': 'green', 'red': 'red',
    'E': 'east', 'S': 'south', 'W': 'west', 'N': 'north',
    'P': 'white', 'F': 'green', 'C': 'red'
  };

  if (honors[str]) {
    return { suit: 'honor', honorType: honors[str] };
  }

  const match = str.match(/^(r?)(\d)(man|pin|sou|m|p|s)$/);
  if (!match) {
    throw new Error(`Invalid tile string: ${str}`);
  }

  const [, redFlag, rankStr, suitStr] = match;
  const suitMap: Record<string, TileSuit> = {
    'man': 'man', 'm': 'man',
    'pin': 'pin', 'p': 'pin',
    'sou': 'sou', 's': 'sou'
  };

  return {
    suit: suitMap[suitStr],
    rank: parseInt(rankStr, 10),
    isRed: redFlag === 'r'
  };
}

/**
 * Check if two tiles are equivalent (ignoring ID and red dora for most purposes)
 */
export function tilesEqual(a: Tile, b: Tile, ignoreRed: boolean = true): boolean {
  if (a.suit !== b.suit) return false;
  if (a.suit === 'honor') {
    return a.honorType === b.honorType;
  }
  if (a.rank !== b.rank) return false;
  if (!ignoreRed && a.isRed !== b.isRed) return false;
  return true;
}
