package in.projecteka.fidelius.health;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
public class HealthController {
    @GetMapping(value = "/health", produces = "application/json")
    public Map<String, Object> health() {
        return Map.of(
                "status", "UP",
                "engine", "fidelius-compatible",
                "cryptoAlg", "ECDH-HKDF-AES-256-GCM",
                "curve", "curve25519"
        );
    }
}
