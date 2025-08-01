import type { Tile } from '../stores/mahjong'
import type { Tile as FourPlayerTile } from '../stores/fourPlayerMahjong'
import { 
  calculateShantenSync,
  getUsefulTilesSync,
  getTileIndex as getRustTileIndex,
  createTileFromIndex,
  initMahjongCalculator,
  calculateAcceptanceSync
} from './mahjong-calculator-wrapper'

// ライブラリの初期化
let isLibraryInitialized = false
async function ensureInitialized() {
  if (!isLibraryInitialized) {
    await initMahjongCalculator()
    isLibraryInitialized = true
  }
}

// 後方互換性のため、旧形式の関数も残す
export function convertTilesToSyantenFormat(tiles: Tile[] | FourPlayerTile[]): [number[], number[], number[], number[]] {
  const man = new Array(9).fill(0)
  const pin = new Array(9).fill(0)
  const sou = new Array(9).fill(0)
  const honor = new Array(7).fill(0)

  for (const tile of tiles) {
    if (tile.suit === 'man') {
      man[tile.rank - 1]++
    } else if (tile.suit === 'pin') {
      pin[tile.rank - 1]++
    } else if (tile.suit === 'sou') {
      sou[tile.rank - 1]++
    } else { // honor
      honor[tile.rank - 1]++
    }
  }

  return [man, pin, sou, honor]
}

export function calculateShanten(tiles: Tile[] | FourPlayerTile[]): number {
  // 初期化をバックグラウンドで実行（ノンブロッキング）
  if (!isLibraryInitialized) {
    ensureInitialized().catch(console.error)
  }
  
  // Rustライブラリが利用可能であれば使用、そうでなければフォールバック
  try {
    return calculateShantenSync(tiles)
  } catch (error) {
    console.warn('Rustライブラリでエラーが発生しました。フォールバック処理を実行します。', error)
    // 簡易フォールバック（実際は古いsyantenライブラリの結果）
    return fallbackCalculateShanten(tiles)
  }
}

function fallbackCalculateShanten(tiles: Tile[] | FourPlayerTile[]): number {
  // 簡易的なシャンテン計算（フォールバック用）
  if (tiles.length === 0) return 8
  if (tiles.length === 14) return -1 // 仮の和了判定
  return Math.max(0, Math.floor((14 - tiles.length) / 3))
}

// 鳴き牌を考慮したシャンテン数計算
export function calculateShantenWithMelds(tiles: Tile[] | FourPlayerTile[], melds: Array<{ type: 'pon' | 'kan' | 'chi', tiles: Tile[] }> = []): number {
  // 鳴き牌の数を考慮した手牌枚数チェック
  const meldTileCount = melds.reduce((count, meld) => count + meld.tiles.length, 0)
  const expectedHandTiles = 13 - meldTileCount
  const expectedTotalTiles = [expectedHandTiles, expectedHandTiles + 1] // ツモ前/後

  if (!expectedTotalTiles.includes(tiles.length)) {
    return 8 // 不正な手牌サイズ
  }

  // 鳴き牌がない場合は通常の計算
  if (melds.length === 0) {
    return calculateShanten(tiles)
  }

  // Rustライブラリでシャンテン数を計算
  const handShanten = calculateShanten(tiles)

  // 鳴き牌による面子数を考慮して調整
  // 1面子確定につき、シャンテン数が下がる
  const adjustedShanten = handShanten - melds.length

  // 最小で-1（和了）まで
  return Math.max(-1, adjustedShanten)
}

export function getUsefulTiles(tiles: Tile[] | FourPlayerTile[]): number[] {
  // 初期化をバックグラウンドで実行（ノンブロッキング）
  if (!isLibraryInitialized) {
    ensureInitialized().catch(console.error)
  }
  
  try {
    return getUsefulTilesSync(tiles)
  } catch (error) {
    console.warn('Rustライブラリでエラーが発生しました。フォールバック処理を実行します。', error)
    return fallbackGetUsefulTiles(tiles)
  }
}

function fallbackGetUsefulTiles(tiles: Tile[] | FourPlayerTile[]): number[] {
  const currentShanten = calculateShanten(tiles)
  if (currentShanten === -1) return []

  const useful: number[] = []

  // 全ての可能な牌をテスト (34種類)
  for (let i = 0; i < 34; i++) {
    const testTile = createTileFromIndex(i, 'test')
    const testTiles = [...tiles, testTile]

    const newShanten = calculateShanten(testTiles)

    if (newShanten < currentShanten) {
      useful.push(i)
    }
  }

  return useful
}

// 鳴き牌を考慮した有効牌計算
export function getUsefulTilesWithMelds(tiles: Tile[], melds: Array<{ type: 'pon' | 'kan' | 'chi', tiles: Tile[] }> = []): number[] {
  const currentShanten = calculateShantenWithMelds(tiles, melds)
  if (currentShanten === -1) return []

  const useful: number[] = []

  // 4枚目の牌をチェック（手牌に同じ牌が3枚ある場合やポンしている場合）
  const fourthTileIndices = getFourthTileOpportunities(tiles, melds)

  // 全ての可能な牌をテスト (34種類)
  for (let i = 0; i < 34; i++) {
    const testTile = createTileFromIndex(i, 'test')
    const testTiles = [...tiles, testTile]

    const newShanten = calculateShantenWithMelds(testTiles, melds)

    if (newShanten < currentShanten || fourthTileIndices.includes(i)) {
      useful.push(i)
    }
  }

  return [...new Set(useful)] // 重複除去
}

// 4枚目の牌の機会を検出
function getFourthTileOpportunities(tiles: Tile[], melds: Array<{ type: 'pon' | 'kan' | 'chi', tiles: Tile[] }>): number[] {
  const opportunities: number[] = []

  // 手牌内で同じ牌が3枚ある場合
  const tileCounts = countTilesByIndex(tiles)
  for (const [index, count] of Object.entries(tileCounts)) {
    if (count === 3) {
      opportunities.push(parseInt(index))
    }
  }

  // ポンしている牌の4枚目
  for (const meld of melds) {
    if (meld.type === 'pon' && meld.tiles.length >= 3) {
      const tile = meld.tiles[0]
      const index = getTileIndex(tile)
      opportunities.push(index)
    }
  }

  return opportunities
}

// 牌をインデックス別にカウント
function countTilesByIndex(tiles: Tile[]): Record<number, number> {
  const counts: Record<number, number> = {}

  for (const tile of tiles) {
    const index = getTileIndex(tile)
    counts[index] = (counts[index] || 0) + 1
  }

  return counts
}

// 牌からインデックスを取得（ラッパー関数を使用）
export function getTileIndex(tile: Tile): number {
  return getRustTileIndex(tile)
}

// インデックスから牌を作成（ラッパー関数を使用）  
export { createTileFromIndex }

export function isWinningHand(tiles: Tile[] | FourPlayerTile[]): boolean {
  return calculateShanten(tiles) === -1
}

export function canRiichi(tiles: Tile[] | FourPlayerTile[], discards?: Tile[] | FourPlayerTile[]): boolean {
  // リーチ条件：14枚の手牌でテンパイ判定を行う
  // 1. 14枚の手牌でなければならない
  // 2. どれか1枚を捨てることでテンパイになる
  // 3. まだリーチしていない (GameManagerで判定)
  // 4. 鳴いていない (melds が空) (GameManagerで判定)
  // 5. 1000点以上持っている (GameManagerで判定)

  if (tiles.length !== 14) {
    return false
  }

  // 各牌を1枚ずつ取り除いて、残り13枚でテンパイ（シャンテン0）になるかチェック
  for (let i = 0; i < tiles.length; i++) {
    const testTiles = [...tiles]
    testTiles.splice(i, 1) // i番目の牌を除去

    if (testTiles.length === 13) {
      const shanten = calculateShanten(testTiles)
      if (shanten === 0) {
        return true // 1枚捨てることでテンパイになる
      }
    }
  }

  return false
}

// 鳴き牌を考慮したリーチ判定
export function canRiichiWithMelds(tiles: Tile[] | FourPlayerTile[], melds: Array<{ type: 'pon' | 'kan' | 'chi', tiles: Tile[] }> = []): boolean {
  // 暗カンのみの鳴きであればリーチ可能
  const hasOpenMelds = melds.some(meld => meld.type !== 'kan')
  if (hasOpenMelds) {
    return false
  }

  // 鳴き牌を考慮した実効手牌枚数を計算
  const meldTiles = melds.reduce((total, meld) => total + 3, 0) // カンは3枚として扱う
  const effectiveHandSize = tiles.length + meldTiles


  // 実効手牌が14枚（13枚+ツモ牌1枚）の場合にリーチ判定
  if (effectiveHandSize === 14) {
    // 各牌を1枚ずつ取り除いて、残り牌でテンパイ（シャンテン0）になるかチェック
    for (let i = 0; i < tiles.length; i++) {
      const testTiles = [...tiles]
      testTiles.splice(i, 1) // i番目の牌を除去

      // 実効手牌13枚でテンパイ判定
      if (testTiles.length + meldTiles === 13) {
        const shanten = calculateShanten(testTiles)
        if (shanten === 0) {
          return true
        }
      }
    }
  }

  return false
}

// 役判定の基本的な実装 (簡易版)
export function checkBasicYaku(tiles: Tile[], winTile: Tile, isTsumo: boolean): string[] {
  const yaku: string[] = []

  if (isTsumo) {
    yaku.push('門前清自摸和')
  }

  // リーチ判定は別途実装が必要
  // その他の役も段階的に実装

  return yaku
}

export function calculateScore(yaku: string[], han: number, fu: number): number {
  // 簡易的な得点計算
  // 実際の麻雀得点計算は複雑なので、基本的なもののみ

  if (han >= 13) return 32000 // 役満
  if (han >= 11) return 24000 // 三倍満
  if (han >= 8) return 16000  // 倍満
  if (han >= 6) return 12000  // 跳満
  if (han >= 5) return 8000   // 満貫

  // 通常の計算 (簡易版)
  let baseScore = fu * Math.pow(2, han + 2)
  if (baseScore > 8000) baseScore = 8000 // 満貫切り上げ

  return Math.ceil(baseScore / 100) * 100
}

// Import the new scoring function
import { calculateScore as calculateRiichiScore } from './scoring'

// 麻雀の上がり判定（詳細版）
export function checkWinCondition(tiles: FourPlayerTile[], winTile: FourPlayerTile, isTsumo: boolean, riichi: boolean, doraIndicators: FourPlayerTile[], uradoraIndicators: FourPlayerTile[] = [], isDealer: boolean = false, isIppatsu: boolean = false, melds: Array<{ type: 'pon' | 'kan' | 'chi', tiles: FourPlayerTile[], calledTile: FourPlayerTile, fromPlayer?: number }> = [], isHaitei: boolean = false, isDoubleRiichi: boolean = false, isRinshanKaihou: boolean = false, isTenho: boolean = false, isChiho: boolean = false): {
  isWin: boolean
  yaku: Array<{ name: string; han: number }>
  totalHan: number
  fu: number
  basePoints: number
  totalPoints: number
  paymentInfo: string
  yakuman: number
  doraCount: number
  uradoraCount: number
} {
  try {
    // Use riichi-rs-bundlers for accurate scoring calculation
    const scoringResult = calculateRiichiScore({
      hand: tiles,
      winningTile: winTile,
      isTsumo,
      isRiichi: riichi,
      doraIndicators,
      uradoraIndicators,
      isDealer,
      isIppatsu,
      isHaitei,
      isDoubleRiichi,
      isRinshanKaihou,
      isTenho,
      isChiho,
      melds
    })

    if (!scoringResult) {
      return {
        isWin: false,
        yaku: [],
        totalHan: 0,
        fu: 0,
        basePoints: 0,
        totalPoints: 0,
        paymentInfo: '',
        yakuman: 0,
        doraCount: 0,
        uradoraCount: 0
      }
    }

    // 点数が0の場合は役なしとして無効
    if (scoringResult.totalPoints <= 0) {
      return {
        isWin: false,
        yaku: scoringResult.yaku,
        totalHan: scoringResult.han,
        fu: scoringResult.fu,
        basePoints: scoringResult.points,
        totalPoints: 0,
        paymentInfo: '0',
        yakuman: 0,
        doraCount: 0,
        uradoraCount: 0
      }
    }

    // 独自でドラと裏ドラの枚数を計算
    const { actualDoraCount, actualUradoraCount } = calculateActualDoraCount(
      tiles,
      doraIndicators,
      riichi ? uradoraIndicators : []
    )


    // 役満の場合は役満役のみを表示（通常役やドラは除外）
    let modifiedYaku: Array<{ name: string; han: number }>

    if (scoringResult.yakuman > 0) {
      // 役満の場合：役満役のみを表示
      modifiedYaku = scoringResult.yaku.filter(y => {
        // 役満役のリスト
        const yakumanYaku = [
          '天和', '地和', '人和', '国士無双', '国士無双十三面', '四暗刻', '四暗刻単騎',
          '大三元', '小四喜', '大四喜', '字一色', '緑一色', '清老頭', '九蓮宝燈',
          '九蓮宝燈九面', '四槓子', '大車輪'
        ]
        return yakumanYaku.includes(y.name)
      })
    } else {
      // 通常手の場合：従来通りドラを分離
      modifiedYaku = [...scoringResult.yaku]

      // 既存の「ドラ」役を除去
      const doraIndex = modifiedYaku.findIndex(y => y.name === 'ドラ')
      if (doraIndex !== -1) {
        modifiedYaku.splice(doraIndex, 1)
      }

      // 表ドラと裏ドラを別々に追加
      if (actualDoraCount > 0) {
        modifiedYaku.push({ name: 'ドラ', han: actualDoraCount })
      }
      if (actualUradoraCount > 0) {
        modifiedYaku.push({ name: '裏ドラ', han: actualUradoraCount })
      }
    }

    const finalResult = {
      isWin: true,
      yaku: modifiedYaku,
      totalHan: scoringResult.han,
      fu: scoringResult.fu,
      basePoints: scoringResult.points,
      totalPoints: scoringResult.totalPoints,
      paymentInfo: scoringResult.paymentInfo,
      yakuman: scoringResult.yakuman,
      doraCount: actualDoraCount,
      uradoraCount: actualUradoraCount
    }


    return finalResult
  } catch (error) {
    // Fallback to simple logic if riichi-rs-bundlers fails
    const convertedTiles = tiles.map(t => ({ id: t.id, suit: t.suit, rank: t.rank, isRed: t.isRed })) as Tile[]
    const isWin = calculateShanten(convertedTiles) === -1

    if (!isWin) {
      return {
        isWin: false,
        yaku: [],
        totalHan: 0,
        fu: 0,
        basePoints: 0,
        totalPoints: 0,
        paymentInfo: '',
        yakuman: 0,
        doraCount: 0,
        uradoraCount: 0
      }
    }

    // Basic fallback scoring
    const yaku: Array<{ name: string; han: number }> = []

    if (isTsumo) {
      yaku.push({ name: '門前清自摸和', han: 1 })
    }

    if (riichi) {
      if (isDoubleRiichi) {
        yaku.push({ name: 'ダブルリーチ', han: 2 })
      } else {
        yaku.push({ name: 'リーチ', han: 1 })
      }
    }

    if (isIppatsu && riichi) {
      yaku.push({ name: '一発', han: 1 })
    }

    if (isHaitei && isTsumo) {
      yaku.push({ name: 'ハイテイツモ', han: 1 })
    }

    if (isHaitei && !isTsumo) {
      yaku.push({ name: '河底撈魚', han: 1 })
    }

    if (isRinshanKaihou && isTsumo) {
      yaku.push({ name: '嶺上開花', han: 1 })
    }

    if (hasAllSimples(tiles)) {
      yaku.push({ name: '断ヤオ九', han: 1 })
    }

    const doraCount = countDora(tiles, doraIndicators)
    const uradoraCount = riichi ? countDora(tiles, uradoraIndicators) : 0

    if (doraCount > 0) {
      yaku.push({ name: 'ドラ', han: doraCount })
    }

    if (uradoraCount > 0) {
      yaku.push({ name: '裏ドラ', han: uradoraCount })
    }

    if (yaku.length === 0) {
      return {
        isWin: false,
        yaku: [],
        totalHan: 0,
        fu: 0,
        basePoints: 0,
        totalPoints: 0,
        paymentInfo: '',
        yakuman: 0,
        doraCount,
        uradoraCount
      }
    }

    const totalHan = yaku.reduce((sum, y) => sum + y.han, 0)
    const fu = calculateFu(tiles, winTile, isTsumo)
    const basePoints = calculateScore(yaku.map(y => y.name), totalHan, fu)

    // フォールバック時も支払い形式を計算
    const paymentInfo = isTsumo
      ? (isDealer ? `${Math.ceil(basePoints / 3 / 100) * 100} all` : `${Math.ceil(basePoints / 4 / 100) * 100}-${Math.ceil(basePoints / 2 / 100) * 100}`)
      : `${isDealer ? Math.ceil(basePoints * 1.5 / 100) * 100 : basePoints}`

    return {
      isWin: true,
      yaku,
      totalHan,
      fu,
      basePoints,
      totalPoints: basePoints,
      paymentInfo,
      yakuman: 0,
      doraCount,
      uradoraCount
    }
  }
}

// 簡易的な符計算
function calculateFu(tiles: FourPlayerTile[], winTile: FourPlayerTile, isTsumo: boolean): number {
  let fu = 20 // 基本符

  if (isTsumo) {
    fu += 2 // ツモ符
  }

  // 実際は面子構成や待ちの種類で変わるが、簡易版では固定
  fu += 30 // 面子符（簡易）

  return Math.ceil(fu / 10) * 10 // 10符単位に切り上げ
}

// 清一色判定
function isAllSameSuit(tiles: FourPlayerTile[]): boolean {
  const suits = [...new Set(tiles.map(t => t.suit).filter(s => s !== 'honor'))]
  return suits.length === 1 && tiles.every(t => t.suit !== 'honor')
}

// 混老頭判定
function isAllTerminalsAndHonors(tiles: FourPlayerTile[]): boolean {
  return tiles.every(t =>
    t.suit === 'honor' || t.rank === 1 || t.rank === 9
  )
}

// 断ヤオ九判定
function hasAllSimples(tiles: FourPlayerTile[]): boolean {
  return tiles.every(t =>
    t.suit !== 'honor' && t.rank >= 2 && t.rank <= 8
  )
}

// ドラ計算
function countDora(tiles: FourPlayerTile[], doraIndicators: FourPlayerTile[]): number {
  let count = 0

  for (const tile of tiles) {
    for (const indicator of doraIndicators) {
      if (isDoraFromIndicator(tile, indicator)) {
        count++
      }
    }
  }

  return count
}

// ドラ表示牌からドラを判定
function isDoraFromIndicator(tile: FourPlayerTile, indicator: FourPlayerTile): boolean {
  if (indicator.suit === 'honor') {
    // 字牌の場合
    if (tile.suit !== 'honor') return false

    if (indicator.rank <= 4) {
      // 風牌: 東→南→西→北→東
      const nextRank = indicator.rank === 4 ? 1 : indicator.rank + 1
      return tile.rank === nextRank
    } else {
      // 三元牌: 白→發→中→白
      const nextRank = indicator.rank === 7 ? 5 : indicator.rank + 1
      return tile.rank === nextRank
    }
  } else {
    // 数牌の場合
    if (tile.suit !== indicator.suit) return false

    const nextRank = indicator.rank === 9 ? 1 : indicator.rank + 1
    return tile.rank === nextRank
  }
}

// 実際のドラと裏ドラの枚数を計算
function calculateActualDoraCount(tiles: FourPlayerTile[], doraIndicators: FourPlayerTile[], uradoraIndicators: FourPlayerTile[]): { actualDoraCount: number, actualUradoraCount: number } {
  let actualDoraCount = 0
  let actualUradoraCount = 0

  // 表ドラの計算
  for (const tile of tiles) {
    for (const indicator of doraIndicators) {
      if (isDoraFromIndicator(tile, indicator)) {
        actualDoraCount++
      }
    }
  }

  // 裏ドラの計算
  for (const tile of tiles) {
    for (const indicator of uradoraIndicators) {
      if (isDoraFromIndicator(tile, indicator)) {
        actualUradoraCount++
      }
    }
  }

  return { actualDoraCount, actualUradoraCount }
}

// 受け入れ情報の型定義（ラッパーからエクスポート）
export type { AcceptanceInfo } from './mahjong-calculator-wrapper'

/**
 * 14枚の手牌から各牌を切った時の受け入れ計算
 * @param tiles 14枚の手牌（ツモ牌含む）
 * @param visibleTiles 見えている牌（手牌+ツモ牌+河+ドラ表示牌など）
 * @returns 各牌を切った時の受け入れ情報
 */
export function calculateAcceptance(
  tiles: Tile[] | FourPlayerTile[],
  visibleTiles: Tile[] | FourPlayerTile[] = []
): AcceptanceInfo[] {
  if (tiles.length !== 14) {
    return [] // 14枚でない場合は空を返す
  }

  // 初期化をバックグラウンドで実行（ノンブロッキング）
  if (!isLibraryInitialized) {
    ensureInitialized().catch(console.error)
  }
  
  // Rustライブラリが利用可能であれば高速版を使用
  try {
    return calculateAcceptanceSync(tiles, visibleTiles)
  } catch (error) {
    console.warn('Rustライブラリでエラーが発生しました。フォールバック処理を実行します。', error)
    return fallbackCalculateAcceptance(tiles, visibleTiles)
  }
}

function fallbackCalculateAcceptance(
  tiles: Tile[] | FourPlayerTile[],
  visibleTiles: Tile[] | FourPlayerTile[] = []
): AcceptanceInfo[] {
  const results: AcceptanceInfo[] = []
  const calculatedTileTypes = new Set<string>() // 計算済みの牌種を記録
  
  // 効率化：手牌以外の見えている牌を事前に計算
  const handTileIds = new Set(tiles.map(tile => tile.id))
  const otherVisibleTiles = visibleTiles.filter(tile => !handTileIds.has(tile.id))

  // 各牌を1枚ずつ切ってテンパイになるかチェック
  for (let i = 0; i < tiles.length; i++) {
    const tileToDiscard = tiles[i]
    
    // 同じ種類の牌が既に計算済みかチェック
    const tileTypeKey = `${tileToDiscard.suit}_${tileToDiscard.rank}_${tileToDiscard.isRed || false}`
    if (calculatedTileTypes.has(tileTypeKey)) {
      // 同じ牌種は既に計算済みなので、既存の結果をコピーして牌情報だけ更新
      const existingResult = results.find(r => 
        r.tile.suit === tileToDiscard.suit && 
        r.tile.rank === tileToDiscard.rank && 
        (r.tile as any).isRed === tileToDiscard.isRed
      )
      if (existingResult) {
        results.push({
          ...existingResult,
          tile: tileToDiscard // 実際の牌情報を更新
        })
      }
      continue
    }
    
    const remainingTiles = [...tiles]
    remainingTiles.splice(i, 1) // i番目の牌を切る

    if (remainingTiles.length === 13) {
      const currentShanten = calculateShanten(remainingTiles)

      if (currentShanten === 0) {
        // テンパイの場合、受け入れ牌を計算
        const acceptanceTiles = getUsefulTiles(remainingTiles)
        
        // この牌を切った後の見えている牌を計算（切った後の手牌 + その他の見えている牌）
        const visibleTilesAfterDiscard = [...remainingTiles, ...otherVisibleTiles]
        
        const remainingCounts = acceptanceTiles.map(tileIndex =>
          getTileRemainingCount(tileIndex, visibleTilesAfterDiscard)
        )
        const totalAcceptance = remainingCounts.reduce((sum, count) => sum + count, 0)

        results.push({
          tileIndex: getTileIndex(tileToDiscard),
          tile: tileToDiscard,
          acceptanceTiles,
          remainingCounts,
          totalAcceptance,
          shantenAfterDiscard: 0 // テンパイなので0
        })
        
        // この牌種を計算済みとしてマーク
        calculatedTileTypes.add(tileTypeKey)
      }
    }
  }

  return results
}

/**
 * 指定された牌の残り枚数を計算（見えている牌を除外）
 * @param tileIndex 牌のインデックス（0-33）
 * @param visibleTiles 見えている牌（手牌+ツモ牌+河+ドラ表示牌など）
 * @returns 残り枚数
 */
export function getTileRemainingCount(
  tileIndex: number,
  visibleTiles: Tile[] | FourPlayerTile[]
): number {
  // 通常の牌は4枚、赤ドラは考慮しない（簡略化）
  const maxCount = 4

  // 見えている牌のうち、指定インデックスの牌をカウント
  let visibleCount = 0
  for (const tile of visibleTiles) {
    if (getTileIndex(tile) === tileIndex) {
      visibleCount++
    }
  }

  return Math.max(0, maxCount - visibleCount)
}

/**
 * 最もシャンテン数が小さく、かつ受け入れ枚数が多い牌のインデックスを取得
 * @param acceptanceInfos 受け入れ情報の配列
 * @returns 最適な牌のインデックス配列
 */
export function findBestAcceptanceTiles(acceptanceInfos: AcceptanceInfo[]): number[] {
  if (acceptanceInfos.length === 0) {
    return []
  }

  // 最小シャンテン数を見つける
  const minShanten = Math.min(...acceptanceInfos.map(info => info.shantenAfterDiscard))

  // 最小シャンテン数の牌のみにフィルタ
  const minShantenTiles = acceptanceInfos.filter(info => info.shantenAfterDiscard === minShanten)

  // その中で最大受け入れ枚数を見つける
  const maxAcceptance = Math.max(...minShantenTiles.map(info => info.totalAcceptance))

  // 最小シャンテン数かつ最大受け入れ枚数の牌インデックスを返す
  return minShantenTiles
    .filter(info => info.totalAcceptance === maxAcceptance)
    .map(info => info.tileIndex)
}

/**
 * フリテン状態かどうかを判定
 * @param tiles 手牌（13枚）
 * @param discards 自分の捨て牌
 * @returns フリテンならtrue
 */
export function isFuriten(tiles: Tile[] | FourPlayerTile[], discards: Tile[] | FourPlayerTile[]): boolean {
  // テンパイ状態でない場合はフリテンではない
  if (calculateShanten(tiles) !== 0) {
    return false
  }

  // 待ち牌（受け入れ牌）を取得
  const waitingTiles = getUsefulTiles(tiles)

  // 自分の河に待ち牌があるかチェック
  for (const discard of discards) {
    const discardIndex = getTileIndex(discard)
    if (waitingTiles.includes(discardIndex)) {
      return true // 待ち牌が河にある = フリテン
    }
  }

  return false
}