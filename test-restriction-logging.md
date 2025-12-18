# Test Plan: Restriction Rule Logging Implementation

## Summary
Added comprehensive logging for all restriction rule rejections in ticket creation flow.

## Logging Points Added

### 1. **Multiplier Restrictions** (Lines 797-842)
- **Action**: `RESTRICTION_MULTIPLIER_REJECTED` (non-admin rejection)
- **Action**: `RESTRICTION_MULTIPLIER_ALLOWED_ADMIN` (admin bypass)
- **Level**: `logger.warn()`
- **Data logged**:
  - `restrictionType`: "LOTTERY_MULTIPLIER"
  - `ruleId`, `scope`, `userId`, `ventanaId`, `bancaId`, `sorteoId`
  - `loteriaId`, `loteriaName`, `multiplierId`, `multiplierName`
  - `jugadaNumber`, `jugadaAmount`, `actorRole`
  - `message` (custom or default)
  - `reason`: Description of why rejected

### 2. **MaxAmount (Specific Numbers)** (Lines 931-953)
- **Action**: `RESTRICTION_MAXAMOUNT_REJECTED`
- **Level**: `logger.warn()`
- **Data logged**:
  - `restrictionType`: "MAX_AMOUNT_PER_TICKET"
  - `ruleId`, `scope`, `userId`, `ventanaId`, `bancaId`, `sorteoId`
  - `number`: The specific number that failed
  - `numbersInRule`: All numbers validated by this rule
  - `amountInTicket`: Total amount for this number in ticket
  - `effectiveMaxAmount`: Effective limit (considers dynamic)
  - `staticMaxAmount`: Static limit from rule
  - `dynamicLimit`: Dynamic limit (if any)
  - `exceeded`: How much over the limit
  - `isAutoDate`, `message`
  - `reason`: Description of why rejected

### 3. **MaxAmount (Global Rules)** (Lines 1087-1108)
- **Action**: `RESTRICTION_MAXAMOUNT_GLOBAL_REJECTED`
- **Level**: `logger.warn()`
- **Data logged**:
  - `restrictionType`: "MAX_AMOUNT_PER_TICKET_GLOBAL"
  - Same fields as specific number validation
  - `scopeLabel`: Human-readable scope ("personal", "de ventana", "de banca")

### 4. **MaxTotal (Specific Numbers)** (Lines 1043-1063)
- **Action**: `RESTRICTION_MAXTOTAL_REJECTED`
- **Level**: `logger.warn()`
- **Data logged**:
  - `restrictionType`: "MAX_TOTAL_IN_SORTEO"
  - `ruleId`, `scope`, `userId`, `ventanaId`, `bancaId`, `sorteoId`
  - `numbersValidated`: Array of numbers checked
  - `numbersInRule`: Numbers from rule (may include isAutoDate)
  - `staticMaxTotal`: Static limit from rule
  - `dynamicLimit`: Dynamic limit (if any)
  - `isAutoDate`, `message`
  - `errorMessage`: Detailed error from helper
  - `reason`: Description of why rejected

**Note**: Additional detailed logging already exists in `validateMaxTotalForNumbers()` helper (lines 325-343) with:
  - `accumulatedInSorteo`: Current accumulated amount
  - `amountForNumber`: Amount from new ticket
  - `newAccumulated`: Total after adding new ticket
  - `available`: How much can still be added

### 5. **MaxTotal (Global Rules)** (Lines 1201-1219)
- **Action**: `RESTRICTION_MAXTOTAL_GLOBAL_REJECTED`
- **Level**: `logger.warn()`
- **Data logged**:
  - `restrictionType`: "MAX_TOTAL_IN_SORTEO_GLOBAL"
  - Same fields as specific number maxTotal validation
  - Additional context for global rule application

## Log Structure

All logs follow this consistent structure:

```typescript
logger.warn({
  layer: 'repository',
  action: 'RESTRICTION_*_REJECTED',
  payload: {
    restrictionType: string,
    ruleId: string,
    scope: "USER" | "VENTANA" | "BANCA",
    userId: string,
    ventanaId: string,
    bancaId: string,
    sorteoId: string,
    // ... specific fields
    message: string | null,  // Custom message from rule
    reason: string,          // Human-readable explanation
  }
})
```

## Test Scenarios

### Scenario 1: Multiplier Restriction
**Setup**:
- Create a RestrictionRule with `loteriaId` and `multiplierId`
- Try to create ticket with that multiplier as non-admin

**Expected Log**:
```json
{
  "layer": "repository",
  "action": "RESTRICTION_MULTIPLIER_REJECTED",
  "payload": {
    "restrictionType": "LOTTERY_MULTIPLIER",
    "ruleId": "...",
    "scope": "VENTANA",
    "loteriaName": "Tica",
    "multiplierName": "x90",
    "jugadaNumber": "15",
    "jugadaAmount": 1000,
    "actorRole": "VENDEDOR",
    "reason": "Multiplier restricted for this lottery"
  }
}
```

### Scenario 2: MaxAmount Exceeded
**Setup**:
- Create RestrictionRule with `number: "15"`, `maxAmount: 5000`
- Try to create ticket with 6000 on number 15

**Expected Log**:
```json
{
  "layer": "repository",
  "action": "RESTRICTION_MAXAMOUNT_REJECTED",
  "payload": {
    "restrictionType": "MAX_AMOUNT_PER_TICKET",
    "number": "15",
    "amountInTicket": 6000,
    "effectiveMaxAmount": 5000,
    "exceeded": 1000,
    "reason": "Amount for this number in ticket exceeds maxAmount limit"
  }
}
```

### Scenario 3: MaxTotal Exceeded
**Setup**:
- Create RestrictionRule with `number: "20"`, `maxTotal: 50000`
- Create tickets totaling 48000 on number 20
- Try to create ticket with 3000 on number 20

**Expected Logs**:
1. From helper (validateMaxTotalForNumbers):
```json
{
  "action": "MAXTOTAL_EXCEEDED",
  "payload": {
    "number": "20",
    "accumulatedInSorteo": 48000,
    "amountForNumber": 3000,
    "newAccumulated": 51000,
    "effectiveMaxTotal": 50000,
    "available": 2000
  }
}
```

2. From repository:
```json
{
  "action": "RESTRICTION_MAXTOTAL_REJECTED",
  "payload": {
    "restrictionType": "MAX_TOTAL_IN_SORTEO",
    "numbersValidated": ["20"],
    "staticMaxTotal": 50000,
    "errorMessage": "El número 20 excede el límite..."
  }
}
```

### Scenario 4: Dynamic Limit Applied
**Setup**:
- Create RestrictionRule with `baseAmount: 10000`, `salesPercentage: 5`, `maxAmount: 50000`
- Sorteo has 100000 in sales
- Dynamic limit = 10000 + (100000 * 0.05) = 15000
- Effective limit = min(50000, 15000) = 15000
- Try ticket with 16000

**Expected Log**:
```json
{
  "action": "RESTRICTION_MAXAMOUNT_REJECTED",
  "payload": {
    "amountInTicket": 16000,
    "effectiveMaxAmount": 15000,
    "staticMaxAmount": 50000,
    "dynamicLimit": 15000,
    "exceeded": 1000
  }
}
```

## Benefits

1. **Complete Audit Trail**: Every rejection is logged with full context
2. **Debugging**: Easy to identify which rule caused rejection
3. **Monitoring**: Can track patterns of rejections by scope, number, etc.
4. **Compliance**: Full record of why tickets were rejected
5. **Analytics**: Can analyze rejection rates, most restrictive rules, etc.

## Log Analysis Queries

### Find all rejections for a specific user:
```
{ payload.userId: "..." }
```

### Find all rejections for a specific number:
```
{ payload.number: "15" }
```

### Find all rejections by rule:
```
{ payload.ruleId: "..." }
```

### Find all dynamic limit applications:
```
{ payload.dynamicLimit: { $exists: true, $ne: null } }
```

### Count rejections by type:
```javascript
db.logs.aggregate([
  { $match: { action: { $regex: "RESTRICTION_.*_REJECTED" } } },
  { $group: { _id: "$payload.restrictionType", count: { $sum: 1 } } }
])
```
