import SwiftUI
import HappyDriveCore

/// 学ぶ：講習一覧と保有資格の期限
struct LearningHomeView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var state: LoadState<[CourseSummary]> = .idle

    var body: some View {
        List {
            if let skills = env.session.user?.skillDetails, !skills.isEmpty {
                Section("保有資格・講習") {
                    ForEach(skills) { skill in
                        SkillRow(skill: skill)
                    }
                }
            }
            switch state {
            case .idle, .loading:
                Section { LoadingStateView() }
            case .failed(let m):
                Section { ErrorStateView(message: m) { Task { await load() } } }
            case .loaded(let courses):
                Section {
                    if courses.isEmpty {
                        Text("受講できる講習はまだありません").foregroundStyle(HDColor.textSecondary)
                    }
                    ForEach(courses) { c in
                        NavigationLink(value: AppRoute.course(c.id)) {
                            CourseRow(course: c)
                        }
                    }
                } header: {
                    Text("講習")
                } footer: {
                    Text("講習と確認テストに合格すると、案件に必要な資格（有効期限付き）が付与されます。")
                }
            }
        }
        .navigationTitle("学ぶ")
        .refreshable {
            await load()
            await env.session.refreshUser()
        }
        .task { await load() }
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await env.api.courses())
        } catch {
            state = .failed(error.hdUserMessage)
        }
    }
}

struct CourseRow: View {
    let course: CourseSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(course.title).font(.hd(.headline, .bold))
            if let s = course.summary { Text(s).font(.hd(.subheadline)).foregroundStyle(HDColor.textSecondary) }
            HStack(spacing: HDSpacing.sm) {
                Label("約\(HDFormat.duration(minutes: course.durationMinutes))", systemImage: "clock")
                if let skill = course.grantsSkillName {
                    Label(skill, systemImage: "graduationcap")
                }
            }
            .font(.hd(.caption))
            .foregroundStyle(HDColor.textSecondary)
            if course.completed {
                StatusBadge(presentation: StatusPresentation(course.skillValidUntil.map { "修了（\(HDFormat.displayAPIDate($0))まで有効）" } ?? "修了", "checkmark.seal.fill", .success), compact: true)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

struct SkillRow: View {
    let skill: Skill

    private var expiryWarning: String? {
        guard let until = skill.validUntil, let date = HDFormat.parseAPIDate(until) else { return nil }
        let days = Calendar.current.dateComponents([.day], from: Date(), to: date).day ?? 0
        if days < 0 { return "期限切れです。更新してください。" }
        if days <= 30 { return "あと\(days)日で期限が切れます" }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(skill.name).font(.hd(.body, .semibold))
                Spacer()
                StatusBadge(presentation: skill.status.presentation, compact: true)
            }
            if let until = skill.validUntil {
                Text("有効期限 \(HDFormat.displayAPIDate(until))").font(.hd(.footnote)).foregroundStyle(HDColor.textSecondary)
            }
            if let warn = expiryWarning {
                Label(warn, systemImage: "exclamationmark.triangle.fill").font(.hd(.footnote)).foregroundStyle(HDColor.warning)
            }
            if let note = skill.note, !note.isEmpty {
                Text(note).font(.hd(.footnote)).foregroundStyle(HDColor.textSecondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// 講習の教材と確認テスト
struct CourseDetailView: View {
    @Environment(AppEnvironment.self) private var env
    let courseId: String
    @State private var state: LoadState<Course> = .idle
    @State private var showQuiz = false

    var body: some View {
        LoadStateContainer(state: state, retry: { Task { await load() } }) { course in
            List {
                Section {
                    if let s = course.summary { Text(s).font(.hd(.body)) }
                    InfoRow(title: "所要時間", value: "約\(HDFormat.duration(minutes: course.durationMinutes))")
                    if let skill = course.grantsSkillName { InfoRow(title: "取得できる資格", value: skill) }
                    if course.completed, let until = course.skillValidUntil {
                        InfoRow(title: "有効期限", value: HDFormat.displayAPIDate(until))
                    }
                }
                Section("教材") {
                    ForEach(Array(course.lessons.enumerated()), id: \.offset) { i, lesson in
                        DisclosureGroup {
                            Text(lesson.body).font(.hd(.body)).padding(.vertical, 4)
                        } label: {
                            Text("\(i + 1). \(lesson.title)").font(.hd(.headline))
                        }
                    }
                }
                if !course.questions.isEmpty {
                    Section {
                        Button(course.completed ? "確認テストを受け直す" : "確認テストを受ける") { showQuiz = true }
                            .buttonStyle(.hdPrimary)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    } footer: {
                        Text("全\(course.questions.count)問。\(course.passScore)問以上の正解で合格です。")
                    }
                }
            }
            .sheet(isPresented: $showQuiz) {
                QuizView(course: course) {
                    Task {
                        await load()
                        await env.session.refreshUser()
                    }
                }
            }
        }
        .navigationTitle(state.value?.title ?? "講習")
        .task { await load() }
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await env.api.course(id: courseId))
        } catch {
            state = .failed(error.hdUserMessage)
        }
    }
}

/// 確認テスト（採点はサーバー）
struct QuizView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let course: Course
    let onFinished: () -> Void

    @State private var answers: [String: Int] = [:]
    @State private var result: QuizResult?
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var key = IdempotencyKey.generate()

    var body: some View {
        NavigationStack {
            Form {
                if let result {
                    resultSection(result)
                } else {
                    ForEach(Array(course.questions.enumerated()), id: \.element.id) { i, q in
                        Section("問\(i + 1)") {
                            Text(q.question).font(.hd(.body, .semibold))
                            ForEach(Array(q.choices.enumerated()), id: \.offset) { ci, choice in
                                Button {
                                    answers[q.id] = ci
                                    key = IdempotencyKey.generate()
                                } label: {
                                    HStack {
                                        Image(systemName: answers[q.id] == ci ? "largecircle.fill.circle" : "circle")
                                            .foregroundStyle(HDColor.brandBlue)
                                            .accessibilityHidden(true)
                                        Text(choice).foregroundStyle(HDColor.textPrimary)
                                    }
                                    .frame(minHeight: 44, alignment: .leading)
                                }
                                .accessibilityAddTraits(answers[q.id] == ci ? .isSelected : [])
                            }
                        }
                    }
                    if let errorMessage {
                        Section { NoticeBox(kind: .danger, text: errorMessage) }
                    }
                    Section {
                        Button {
                            Task { await submit() }
                        } label: {
                            ProgressLabel(title: "採点する", isLoading: isSubmitting)
                        }
                        .buttonStyle(.hdPrimary)
                        .disabled(answers.count < course.questions.count || isSubmitting)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    }
                }
            }
            .navigationTitle("確認テスト")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private func resultSection(_ r: QuizResult) -> some View {
        Section {
            Label(r.passed ? "合格です" : "不合格です", systemImage: r.passed ? "checkmark.seal.fill" : "xmark.seal")
                .font(.hd(.title2, .bold))
                .foregroundStyle(r.passed ? HDColor.jobGreen : HDColor.warning)
            InfoRow(title: "結果", value: "\(r.score) / \(r.total)問 正解")
            if let skill = r.grantedSkill {
                InfoRow(title: "付与された資格", value: skill.name)
                if let until = skill.validUntil { InfoRow(title: "有効期限", value: HDFormat.displayAPIDate(until)) }
            }
        }
        if let wrong = r.incorrectQuestionIds, !wrong.isEmpty {
            Section("見直しが必要な問題") {
                ForEach(wrong, id: \.self) { id in
                    if let q = course.questions.first(where: { $0.id == id }) {
                        Text(q.question).font(.hd(.subheadline))
                    }
                }
            }
        }
        Section {
            if !r.passed {
                Button("もう一度受ける") {
                    result = nil
                    answers = [:]
                    key = IdempotencyKey.generate()
                }
                .buttonStyle(.hdSecondary)
            }
            Button("閉じる") {
                onFinished()
                dismiss()
            }
            .buttonStyle(.hdPrimary)
        }
        .listRowBackground(Color.clear)
    }

    private func submit() async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        let payload = course.questions.compactMap { q in answers[q.id].map { QuizAnswer(questionId: q.id, choiceIndex: $0) } }
        do {
            result = try await env.api.submitQuiz(courseId: course.id, answers: payload, idempotencyKey: key)
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}
