;; Token Streaming Protocol - Fixed Version

;; Error codes
(define-constant ERR_UNAUTHORIZED (err u0))
(define-constant ERR_INVALID_SIGNATURE (err u1))
(define-constant ERR_STREAM_STILL_ACTIVE (err u2))
(define-constant ERR_INVALID_STREAM_ID (err u3))
(define-constant ERR_NO_WITHDRAWABLE_BALANCE (err u4))
(define-constant ERR_NO_REFUNDABLE_BALANCE (err u5))
(define-constant ERR_CONSENSUS_BUFFER_CONVERSION (err u6))
(define-constant ERR_INVALID_AMOUNT (err u7))
(define-constant ERR_INVALID_DURATION (err u8))

;; Data variables
(define-data-var latest-stream-id uint u0)

;; Streams mapping
(define-map streams
    uint ;; stream id
    {
        sender: principal,
        recipient: principal,
        balance: uint,
        withdrawn-balance: uint,
        payment-per-block: uint,
        timeframe: (tuple (start-block uint) (stop-block uint))
    }
)

;; Create a new stream
(define-public (stream-to
    (recipient principal)
    (initial-balance uint)
    (timeframe (tuple (start-block uint) (stop-block uint)))
    (payment-per-block uint)
  ) 
  (let (
    (start-block (get start-block timeframe))
    (stop-block (get stop-block timeframe))
    (current-stream-id (var-get latest-stream-id))
    (stream {
        sender: tx-sender,
        recipient: recipient,
        balance: initial-balance,
        withdrawn-balance: u0,
        payment-per-block: payment-per-block,
        timeframe: timeframe
    })
  )
    ;; Validate inputs BEFORE calculating duration
    (asserts! (> initial-balance u0) ERR_INVALID_AMOUNT)
    (asserts! (> stop-block start-block) ERR_INVALID_DURATION)
    
    ;; Calculate duration after validation
    (let ((duration (- stop-block start-block)))
      (asserts! (>= initial-balance duration) ERR_INVALID_AMOUNT)
      
      (try! (stx-transfer? initial-balance tx-sender (as-contract tx-sender)))
      (map-set streams current-stream-id stream)
      (var-set latest-stream-id (+ current-stream-id u1))
      (ok current-stream-id)
    )
  )
)

;; Cancel a stream (sender only, refunds remaining balance)
(define-public (cancel
    (stream-id uint)
  )
  (let (
    (stream (unwrap! (map-get? streams stream-id) ERR_INVALID_STREAM_ID))
    (current-block (+ burn-block-height u1))
    (block-delta (calculate-block-delta (get timeframe stream)))
    (recipient-balance (* block-delta (get payment-per-block stream)))
    (remaining-balance (- (get balance stream) recipient-balance))
  )
    (asserts! (is-eq tx-sender (get sender stream)) ERR_UNAUTHORIZED)
    
    ;; If there's remaining balance, refund to sender
    (if (> remaining-balance u0)
      (begin
        (try! (as-contract (stx-transfer? remaining-balance tx-sender (get sender stream))))
        (map-set streams stream-id 
          (merge stream {balance: recipient-balance})
        )
      )
      true
    )
    (ok remaining-balance)
  )
)

;; Increase the locked STX balance for a stream
(define-public (refuel
    (stream-id uint)
    (amount uint)
  )
  (let (
    (stream (unwrap! (map-get? streams stream-id) ERR_INVALID_STREAM_ID))
  )
    (asserts! (> amount u0) ERR_INVALID_AMOUNT)
    (asserts! (is-eq tx-sender (get sender stream)) ERR_UNAUTHORIZED)
    (try! (stx-transfer? amount tx-sender (as-contract tx-sender)))
    (map-set streams stream-id 
      (merge stream {balance: (+ (get balance stream) amount)})
    )
    (ok amount)
  )
)

;; Calculate how many blocks have elapsed for streaming
(define-read-only (calculate-block-delta
    (timeframe (tuple (start-block uint) (stop-block uint)))
  )
  (let (
    (start-block (get start-block timeframe))
    (stop-block (get stop-block timeframe))
    (current-block (+ burn-block-height u1))
    (delta 
      (if (<= current-block start-block)
        u0
        (if (< current-block stop-block)
          (- current-block start-block)
          (- stop-block start-block)
        ) 
      )
    )
  )
    delta
  )
)

;; Check balance for a party involved in a stream
(define-read-only (balance-of
    (stream-id uint)
    (who principal)
  )
  (match (map-get? streams stream-id)
    stream (let (
      (block-delta (calculate-block-delta (get timeframe stream)))
      (recipient-balance (* block-delta (get payment-per-block stream)))
    )
      (if (is-eq who (get recipient stream))
        (if (> recipient-balance (get withdrawn-balance stream))
          (- recipient-balance (get withdrawn-balance stream))
          u0
        )
        (if (is-eq who (get sender stream))
          (if (> (get balance stream) recipient-balance)
            (- (get balance stream) recipient-balance)
            u0
          )
          u0
        )
      )
    )
    u0
  )
)

;; Withdraw received tokens - Fixed version
(define-public (withdraw
    (stream-id uint)
    (amount uint)  ;; Add amount parameter to match test expectations
  )
  (let (
    (stream (unwrap! (map-get? streams stream-id) ERR_INVALID_STREAM_ID))
    (withdrawable-balance (balance-of stream-id tx-sender))
  )
    (asserts! (is-eq tx-sender (get recipient stream)) ERR_UNAUTHORIZED)
    (asserts! (> withdrawable-balance u0) ERR_NO_WITHDRAWABLE_BALANCE)
    (asserts! (<= amount withdrawable-balance) ERR_INVALID_AMOUNT)
    
    (map-set streams stream-id
      (merge stream {withdrawn-balance: (+ (get withdrawn-balance stream) amount)})
    )
    
    (try! (as-contract (stx-transfer? amount tx-sender (get recipient stream))))
    (ok amount)
  )
)

;; Withdraw excess locked tokens (sender only, after stream ends)
(define-public (refund
    (stream-id uint)
  )
  (let (
    (stream (unwrap! (map-get? streams stream-id) ERR_INVALID_STREAM_ID))
    (refundable-balance (balance-of stream-id (get sender stream)))
  )
    (asserts! (is-eq tx-sender (get sender stream)) ERR_UNAUTHORIZED)
    (asserts! (< (get stop-block (get timeframe stream)) burn-block-height) ERR_STREAM_STILL_ACTIVE)
    (asserts! (> refundable-balance u0) ERR_NO_REFUNDABLE_BALANCE)
    
    (map-set streams stream-id 
      (merge stream {balance: (- (get balance stream) refundable-balance)})
    )
    
    (try! (as-contract (stx-transfer? refundable-balance tx-sender (get sender stream))))
    (ok refundable-balance)
  )
)

;; Get hash of stream for signature verification
(define-read-only (hash-stream
    (stream-id uint)
    (new-payment-per-block uint)
    (new-timeframe (tuple (start-block uint) (stop-block uint)))
  )
  (match (map-get? streams stream-id)
    stream (match (to-consensus-buff? stream)
      stream-buff (match (to-consensus-buff? new-payment-per-block)
        payment-buff (match (to-consensus-buff? new-timeframe)
          timeframe-buff (let (
            (combined-buff (concat (concat stream-buff payment-buff) timeframe-buff))
          )
            (ok (sha256 combined-buff))
          )
          (err ERR_CONSENSUS_BUFFER_CONVERSION)
        )
        (err ERR_CONSENSUS_BUFFER_CONVERSION)
      )
      (err ERR_CONSENSUS_BUFFER_CONVERSION)
    )
    (err ERR_INVALID_STREAM_ID)
  )
)

;; Verify signature
(define-read-only (validate-signature 
    (message-hash (buff 32)) 
    (signature (buff 65)) 
    (signer principal)
  )
  (is-eq 
    (principal-of? (unwrap! (secp256k1-recover? message-hash signature) false)) 
    (ok signer)
  )
)

;; Update stream configuration
(define-public (update-details
    (stream-id uint)
    (new-payment-per-block uint)
    (new-timeframe (tuple (start-block uint) (stop-block uint)))
    (signer principal)
    (signature (buff 65))
  )
  (let (
    (stream (unwrap! (map-get? streams stream-id) ERR_INVALID_STREAM_ID))
    (message-hash (unwrap! (hash-stream stream-id new-payment-per-block new-timeframe) (err u6)))
  )
    (asserts! (validate-signature message-hash signature signer) ERR_INVALID_SIGNATURE)
    (asserts!
      (or
        (and (is-eq (get sender stream) tx-sender) (is-eq (get recipient stream) signer))
        (and (is-eq (get sender stream) signer) (is-eq (get recipient stream) tx-sender))
      )
      ERR_UNAUTHORIZED
    )
    (map-set streams stream-id 
      (merge stream {
        payment-per-block: new-payment-per-block,
        timeframe: new-timeframe
      })
    )
    (ok true)
  )
)

;; Read-only helper functions
(define-read-only (get-stream (stream-id uint))
  (map-get? streams stream-id)
)

(define-read-only (get-latest-stream-id)
  (var-get latest-stream-id)
)