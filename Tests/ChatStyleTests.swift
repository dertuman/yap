import Foundation

@main
enum ChatStyleTests {
    static func main() {
        let style = ChatStyle(prompt: "# comment\nqué onda we", words: ChatStyle.defaultWords)
        assert(style.prompt == "qué onda we")

        // No ¿ ¡, lowercase sentence starts, periods become commas and the last one goes.
        assert(style.apply("¿Qué onda, güey? ¡No mames! Ya llegué.") == "qué onda, we? no mames! ya llegué")
        assert(style.apply("Ahorita voy. Te marco al rato.") == "ahorita voy, te marco al rato")
        // Acronyms, decimals and ellipses survive.
        assert(style.apply("AI está cañón. Llego a las 9.30...") == "AI está cañón, llego a las 9.30...")
        // Whole words only, any case, longest phrase first.
        assert(style.apply("Jajaja no te preocupes, está de la verga") == "hahaha ntp, está dlv")
        assert(style.apply("Weyes") == "weyes")
        // Whisper's output with the prompt, from a real take.
        assert(style.apply("que onda wey, como vas, neta no mames, no te preocupes, jajaja") == "que onda we, como vas, neta no mames, ntp, hahaha")
        assert(style.apply("Ja ja ja.") == "hahaha")
        // Accents are optional on both sides; ñ is not an accented n.
        let codes = ChatStyle(prompt: "", words: "cómo te caería -> ctc\nqué haces si -> qhs\naño -> year")
        assert(codes.apply("Como te caeria una pizza") == "ctc una pizza")
        assert(codes.apply("¿Qué haces si llueve?") == "qhs llueve?")
        assert(codes.apply("ano") == "ano")
        print("ChatStyle tests passed")
    }
}
